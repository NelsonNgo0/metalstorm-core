/**
 * The current-state segment: a player's actual position, appended to a code
 * that otherwise describes intent.
 *
 * build-code.test.mjs is the frozen contract for everything that existed
 * before this segment, and it must pass unchanged. This file covers what the
 * segment adds. The two are kept apart so that a failure says immediately
 * which of the two questions it is answering: did the extension change the old
 * format, or is the new part wrong.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { dispose, loadCodec } from "./subject.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(resolve(here, "fixtures", name), "utf8"));
const fixture = read("build-codes.json");
const forward = read("forward-compat.json");

const BASE = "f-5-tiger.20.F8tttt_E8tttt_A8tttt_PC8tttt_IM8tttt";
const ORIGINAL = process.env.METALSTORM_SUBJECT === "original";

let codec;

before(async () => {
  codec = await loadCodec(fixture);
});

after(async () => {
  await dispose();
});

/** The pre-extension shape, which an old code must still decode to exactly. */
const OLD_KEYS = ["level", "optimised", "picks", "slug"];

describe("the old format is untouched", { skip: ORIGINAL }, () => {
  it("writes every recorded build byte for byte as before", () => {
    // The recorded inputs carry no current state, so every one of them has to
    // come back out unchanged. This is the same assertion build-code.test.mjs
    // makes; it is repeated here because it is the thing this change is most
    // able to break.
    for (const { name, input, code } of fixture.encodeCases) {
      assert.equal(codec.write(input), code, `encode changed for ${name}`);
    }
  });

  it("decodes an old code to an object with no current-state key at all", () => {
    // Not a key set to undefined. deepStrictEqual counts own properties, so an
    // unconditionally-assigned `current: undefined` would fail all 164 decode
    // assertions in the frozen suite.
    for (const { raw } of fixture.decodeCases) {
      for (const build of codec.read(raw)) {
        assert.deepEqual(
          Object.keys(build).sort(),
          OLD_KEYS,
          `decoding ${JSON.stringify(raw)} produced keys ${Object.keys(build)}`,
        );
        assert.ok(!("current" in build));
      }
    }
  });
});

describe("forward compatibility with the shipped reader", { skip: ORIGINAL }, () => {
  for (const { name, raw, decoded } of forward.cases) {
    it(`agrees with the old reader about the build: ${name}`, () => {
      // The extension has to be purely additive: on the same input, the new
      // reader must resolve the same aircraft, level, picks and flag the old
      // one did, and only then add what the old one could not see.
      const parsed = codec.read(raw).map(({ current, ...rest }) => rest);
      assert.deepEqual(parsed, decoded);
    });
  }

  it("recovers state the old reader threw away", () => {
    const old = forward.cases.find((c) => c.name === "empty flag slot then current");
    assert.equal(old.reencoded, BASE, "fixture should show the old reader dropping it");
    const [build] = codec.read(old.raw);
    assert.deepEqual(build.current.systems, {
      Fuselage: 8,
      Engines: 6,
      Avionics: 4,
      "Precision Cannons": 2,
      "Infrared Missiles": 0,
    });
    assert.equal(codec.write([build]), old.raw, "should round trip in the new reader");
  });
});

describe("grammar", { skip: ORIGINAL }, () => {
  const cases = [
    ["systems only", `${BASE}..F8_E6`, { systems: { Fuselage: 8, Engines: 6 } }],
    [
      "aircraft level then systems",
      `${BASE}..12_F8_E6`,
      { aircraftLevel: 12, systems: { Fuselage: 8, Engines: 6 } },
    ],
    ["aircraft level alone", `${BASE}..12`, { aircraftLevel: 12, systems: {} }],
    [
      "unknown marker",
      `${BASE}..F8_E-_A0`,
      { systems: { Fuselage: 8, Engines: null, Avionics: 0 } },
    ],
    ["level zero is a state, not an absence", `${BASE}..F0`, { systems: { Fuselage: 0 } }],
    [
      "with the optimised flag",
      `${BASE}.o.F8_E6`,
      { systems: { Fuselage: 8, Engines: 6 } },
    ],
    ["single digit aircraft level", `${BASE}..7_F8`, { aircraftLevel: 7, systems: { Fuselage: 8 } }],
  ];

  for (const [name, raw, expected] of cases) {
    it(`reads ${name}`, () => {
      const [build] = codec.read(raw);
      assert.deepEqual(build.current, expected);
    });

    it(`round trips ${name}`, () => {
      assert.equal(codec.write(codec.read(raw)), raw);
    });
  }

  it("keeps the optimised flag independent of the current segment", () => {
    assert.equal(codec.read(`${BASE}..F8`)[0].optimised, false);
    assert.equal(codec.read(`${BASE}.o.F8`)[0].optimised, true);
  });
});

describe("observation is preserved, not clamped", { skip: ORIGINAL }, () => {
  // Picks are intent and the clamp encodes a game rule. Current state is an
  // observation of where someone actually is, and rewriting it would hide a
  // typo, a data error or a game change behind a plausible number.

  it("keeps a system level the aircraft level could not have reached", () => {
    const [build] = codec.read("f-5-tiger.6.F2..F8");
    assert.equal(build.picks.Fuselage.tier, 2, "the pick is clamped");
    assert.equal(build.current.systems.Fuselage, 8, "the observation is not");
  });

  it("keeps an aircraft level beyond the ceiling", () => {
    const [build] = codec.read(`${BASE}..99_F8`);
    assert.equal(build.current.aircraftLevel, 99);
  });

  it("keeps a system the aircraft does not carry", () => {
    // AC is a real tree, so it can be named. That this aircraft has no Assault
    // Cannons is a contradiction worth surfacing, not silently deleting.
    const [build] = codec.read(`${BASE}..AC5`);
    assert.equal(build.current.systems["Assault Cannons"], 5);
  });

  it("round trips all three unchanged", () => {
    for (const raw of ["f-5-tiger.6.F2..F8", `${BASE}..99_F8`, `${BASE}..AC5`]) {
      assert.equal(codec.write(codec.read(raw)), raw);
    }
  });
});

describe("malformed current state", { skip: ORIGINAL }, () => {
  // Unparseable is different from contradictory. A value the grammar cannot
  // read has no meaning to preserve, so it is dropped the way a malformed pick
  // is. A value that parses but disagrees with the dataset is kept.
  const dropped = [
    ["empty segment", `${BASE}..`],
    ["unknown tree code", `${BASE}..ZZ5`],
    ["lowercase tree code", `${BASE}..f8`],
    ["state above 8", `${BASE}..F9`],
    ["multi digit state", `${BASE}..F12`],
    ["non numeric state", `${BASE}..Fx`],
    ["code with no state", `${BASE}..F`],
    ["state with no code", `${BASE}.._8`],
  ];

  it("drops a number that is not in the leading position, keeping the entries", () => {
    // A bare number anywhere but the front is a mangled entry. Reading it as
    // an aircraft level would invent a fact the code never carried.
    const [build] = codec.read(`${BASE}..F8_12`);
    assert.deepEqual(build.current, { systems: { Fuselage: 8 } });
  });

  it("drops a three digit leading number, keeping the entries", () => {
    const [build] = codec.read(`${BASE}..120_F8`);
    assert.deepEqual(build.current, { systems: { Fuselage: 8 } });
  });

  for (const [name, raw] of dropped) {
    it(`drops ${name}`, () => {
      const [build] = codec.read(raw);
      const kept = build.current?.systems ?? {};
      assert.equal(Object.keys(kept).length, 0, `kept ${JSON.stringify(kept)}`);
    });
  }

  it("omits the current key entirely when nothing parses", () => {
    for (const [, raw] of dropped) {
      const [build] = codec.read(raw);
      assert.ok(!("current" in build), `${raw} produced a current key`);
    }
  });

  it("keeps the good entries beside a bad one", () => {
    const [build] = codec.read(`${BASE}..F8_ZZ5_E6`);
    assert.deepEqual(build.current.systems, { Fuselage: 8, Engines: 6 });
  });

  it("never throws", () => {
    const junk = [
      `${BASE}..`,
      `${BASE}...`,
      `${BASE}..___`,
      `${BASE}..${"F8_".repeat(500)}`,
      `${BASE}..-`,
      `${BASE}..--`,
      `${BASE}..F-`,
      `${BASE}..0`,
      `${BASE}..00`,
      `${BASE}..__proto__8`,
      `${BASE}..constructor5`,
      "f-5-tiger.20...",
      "f-5-tiger....",
    ];
    for (const raw of junk) {
      assert.doesNotThrow(() => codec.read(raw), `threw on ${raw}`);
      assert.doesNotThrow(() => codec.write(codec.read(raw)));
    }
  });

  it("does not let a tree named like a prototype key reach the object", () => {
    const [build] = codec.read(`${BASE}..__proto__8`);
    assert.equal(({}).__proto__8, undefined);
    assert.ok(build.current === undefined || !("__proto__8" in build.current.systems));
  });
});

describe("across multiple builds", { skip: ORIGINAL }, () => {
  it("carries current state on some builds and not others", () => {
    const raw = `${BASE}..F8_E6*su-27-flanker.20.F8bbbb`;
    const builds = codec.read(raw);
    assert.equal(builds.length, 2);
    assert.deepEqual(builds[0].current.systems, { Fuselage: 8, Engines: 6 });
    assert.ok(!("current" in builds[1]));
    assert.equal(codec.write(builds), raw);
  });

  it("still stops at the build cap", () => {
    const raw = fixture.dataset.aircraft
      .slice(0, 6)
      .map((a) => `${a.slug}.20...F8_E6`)
      .join("*");
    const builds = codec.read(raw);
    assert.equal(builds.length, codec.maxBuilds);
    for (const b of builds) assert.deepEqual(b.current.systems, { Fuselage: 8, Engines: 6 });
  });

  it("writes more than the cap, as it always did", () => {
    const builds = fixture.dataset.aircraft.slice(0, 5).map((a) => ({
      slug: a.slug,
      level: 20,
      picks: {},
      current: { systems: { Fuselage: 8 } },
    }));
    assert.equal(codec.write(builds).split("*").length, 5);
  });
});

describe("clamp leaves observations alone", { skip: ORIGINAL }, () => {
  it("passes current state through untouched", () => {
    const current = { aircraftLevel: 99, systems: { Fuselage: 8, Engines: null } };
    const out = codec.clamp({ slug: "f-5-tiger", level: 6, picks: {}, current });
    assert.deepEqual(out.current, current);
  });

  it("adds no current key to a build that had none", () => {
    const out = codec.clamp({ slug: "f-5-tiger", level: 20, picks: {} });
    assert.ok(!("current" in out));
  });
});
