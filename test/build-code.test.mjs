/**
 * Characterisation tests for the build code.
 *
 * A build code is a URL someone has pasted into a comment, a Discord message
 * or a bookmark. Once it is out there it has to keep decoding to the build it
 * described. This suite is not about whether the format is good. It is about
 * whether the format has changed. Every expectation is a recording of what the
 * shipped implementation actually produced, taken by
 * `src/metalstorm/scripts/record-build-codes.mjs`, not a description of what
 * it ought to produce.
 *
 * Run: node --test packages/metalstorm-core/test/
 *
 * A failure here means one of two things. Either the extraction changed
 * behaviour, which is a bug in the extraction, or the dataset changed under
 * the format, which is a decision someone has to make deliberately. Neither is
 * fixed by re-recording the fixture until it goes green.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { dispose, loadCodec } from "./subject.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "fixtures/build-codes.json"), "utf8"),
);

/**
 * The twelve tree codes, written out rather than read from the fixture.
 *
 * These are the public half of the format. A code appears verbatim in every
 * shared link, so changing one silently repoints every bookmark that carried
 * it at a different system, or at nothing. They are derived from tree names
 * at runtime in the original, which means a tree being renamed or added could
 * move one without anyone editing a line of code.
 *
 * Duplicating them here is deliberate. If they were read from the fixture, a
 * re-record would bless the change and this test would keep passing while the
 * contract broke. The point is that changing a code requires editing this
 * list, by hand, in a commit someone has to justify.
 */
const FROZEN_TREE_CODES = {
  Fuselage: "F",
  Engines: "E",
  Avionics: "A",
  "Precision Cannons": "PC",
  "Assault Cannons": "AC",
  "Precision Cannon Pods": "PCP",
  "Assault Cannon Pods": "ACP",
  Rockets: "R",
  "Infrared Missiles": "IM",
  "Manual Missiles": "MM",
  "Radar Missiles": "RM",
  "Beam Riding Missiles": "BRM",
};

let codec;

before(async () => {
  codec = await loadCodec(fixture);
});

after(async () => {
  await dispose();
});

describe("tree codes", () => {
  it("still spells all twelve exactly as shared links carry them", () => {
    for (const [name, code] of Object.entries(FROZEN_TREE_CODES)) {
      assert.equal(
        codec.treeCodes[name],
        code,
        `tree code for "${name}" moved from ${code} to ${codec.treeCodes[name]}; ` +
          `every shared link containing ${code} now decodes differently`,
      );
    }
  });

  it("has not grown or lost a tree without that being noticed", () => {
    assert.deepEqual(
      Object.keys(codec.treeCodes).sort(),
      Object.keys(FROZEN_TREE_CODES).sort(),
    );
  });

  it("assigns every tree a distinct code", () => {
    const codes = Object.values(codec.treeCodes);
    assert.equal(new Set(codes).size, codes.length);
  });

  it("uses only characters the pick grammar can read back", () => {
    for (const code of Object.values(codec.treeCodes)) {
      assert.match(code, /^[A-Z]+$/);
    }
  });
});

describe("constants", () => {
  it("caps aircraft level where the hit point track ends", () => {
    assert.equal(codec.MAX_AIRCRAFT_LEVEL, fixture.constants.MAX_AIRCRAFT_LEVEL);
  });

  it("starts splitting at the recorded tier", () => {
    assert.equal(codec.SPLIT_FROM, fixture.constants.SPLIT_FROM);
  });

  it("reads at most the recorded number of builds", () => {
    assert.equal(codec.MAX_BUILDS, fixture.constants.MAX_BUILDS);
  });
});

describe("encoding", () => {
  for (const { name, input, code } of fixture.encodeCases) {
    it(`writes ${name}`, () => {
      assert.equal(codec.write(input), code);
    });
  }

  it("covers all 43 aircraft", () => {
    const slugs = new Set(fixture.dataset.aircraft.map((a) => a.slug));
    assert.equal(slugs.size, 43);
    for (const slug of slugs) {
      assert.ok(
        fixture.encodeCases.some((c) => c.name === `max build: ${slug}`),
        `no recorded max build for ${slug}`,
      );
    }
  });

  it("does not cap how many builds it writes", () => {
    // The cap is a read-side rule. Writing five builds produces five, and the
    // fifth is dropped only when the string is read back. Capping the writer
    // would change what a link with five builds in it looks like.
    const five = fixture.encodeCases.find((c) => c.name === "5 build(s) joined");
    assert.equal(five.code.split("*").length, 5);
    assert.equal(codec.write(five.input).split("*").length, 5);
  });
});

describe("decoding", () => {
  for (const { name, raw, decoded, reencoded } of fixture.decodeCases) {
    it(`reads ${name}`, () => {
      const parsed = codec.read(raw);
      assert.deepEqual(parsed, decoded);
      assert.equal(codec.write(parsed), reencoded);
    });
  }
});

describe("round trips", () => {
  const capped = new Set(["round trip: 5 build(s) joined"]);

  for (const { name, code } of fixture.encodeCases) {
    it(`survives a round trip: ${name}`, () => {
      const again = codec.write(codec.read(code));
      if (capped.has(`round trip: ${name}`)) {
        // Reading drops everything past the cap, so this one is deliberately
        // not stable. It is listed by name so a NEW instability cannot hide
        // behind a blanket exemption.
        assert.notEqual(again, code);
        return;
      }
      assert.equal(again, code);
    });
  }

  it("is stable a second time round for everything, cap included", () => {
    for (const { code } of fixture.encodeCases) {
      const once = codec.write(codec.read(code));
      assert.equal(codec.write(codec.read(once)), once);
    }
  });
});

describe("malformed input", () => {
  it("never throws, whatever it is handed", () => {
    const junk = [
      null,
      "",
      "   ",
      "*",
      "***",
      ".",
      "..",
      "....",
      "!!!",
      "%%%%",
      "a".repeat(5000),
      "*".repeat(500),
      "f-5-tiger.".repeat(200),
      "\n\t",
      "f-5-tiger.20.F8tttt ",
      "F8tttt",
      "20.f-5-tiger",
      "f-5-tiger.20.F-1",
      "f-5-tiger.1e3.F8tttt",
      "f-5-tiger.0x14.F8tttt",
      "f-5-tiger.Infinity.F8tttt",
      "f-5-tiger.NaN.F8tttt",
      "__proto__.20.F8tttt",
      "constructor.20.F8tttt",
      "f-5-tiger.20.__proto__8tttt",
    ];
    for (const raw of junk) {
      assert.doesNotThrow(() => codec.read(raw), `threw on ${JSON.stringify(raw)}`);
      const parsed = codec.read(raw);
      assert.ok(Array.isArray(parsed), `did not return an array for ${JSON.stringify(raw)}`);
      assert.ok(parsed.length <= codec.MAX_BUILDS);
      assert.doesNotThrow(() => codec.write(parsed));
    }
  });

  it("degrades to a smaller valid build rather than an error", () => {
    // Every parser in this tool follows the same rule: an unrecognised part is
    // dropped, not fatal. A stale link should open a narrower view, never a
    // broken page.
    for (const { raw, decoded } of fixture.decodeCases) {
      const parsed = codec.read(raw);
      assert.equal(parsed.length, decoded.length);
      for (const build of parsed) {
        assert.equal(typeof build.slug, "string");
        assert.ok(build.level >= 1 && build.level <= codec.MAX_AIRCRAFT_LEVEL);
        for (const pick of Object.values(build.picks)) {
          assert.ok(pick.tier >= 1, "a tier of 0 should have been dropped, not kept");
          assert.match(pick.paths, /^[tb]*$/);
        }
      }
    }
  });

  it("never invents a build out of nothing", () => {
    for (const raw of [null, "", "   ", "*", "garbage"]) {
      assert.deepEqual(codec.read(raw), []);
    }
  });
});
