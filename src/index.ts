/**
 * The MetalStorm build code format, and the types two apps need to agree on
 * to share one.
 *
 * A build code is a string people paste into comments and save as bookmarks.
 * Once it is out there it has to keep decoding to the build it described, for
 * as long as anyone might click it. That requirement is why this package has
 * no dependencies, no bundled data, and no DOM: it has to import the same way
 * into a Vite web app and an Electron main process, and it has to stay small
 * enough that nothing in it can quietly change what a string means.
 *
 * Reading a code is not a pure string operation. It validates and re-seats the
 * result against real data, so the codec is built over a dataset you inject:
 *
 *   const codec = createBuildCodec({ trees, aircraft, maxAircraftLevel });
 *   codec.write(builds);
 *   codec.read(raw);
 *
 * Both apps build that dataset from their own copy of the wiki data. Same data
 * in, same bytes out. Different data in, and the two will disagree, which is a
 * failure you can see rather than one that hides.
 */

export interface BuildPick {
  tier: number;
  /** One character per split tier, in tier order: "t" top, "b" bottom. */
  paths: string;
}

export interface Build {
  slug: string;
  level: number;
  /**
   * Insertion order is the order picks are written into a code. Build a Build
   * by hand and you have to insert in the aircraft's own tree order, or run it
   * through `clamp`, which rebuilds the record in that order.
   */
  picks: Record<string, BuildPick>;
  /**
   * Marks a build whose forks came from a weighting rather than from hand
   * picking. Rides in the code as a trailing `.o` and changes nothing about
   * how the build is read.
   */
  optimised?: boolean;
}

/**
 * The slug is what appears in build codes and URLs, so it is the thing both
 * apps have to agree on. Everything else the wiki publishes about an aircraft
 * is a consumer's concern and belongs in an interface that extends this one.
 */
export interface AircraftIdentity {
  slug: string;
  name: string;
}

/**
 * What the codec needs to know about an aircraft.
 *
 * Kept separate from AircraftIdentity because the codec has no use for a
 * display name, and a dataset should not have to supply one.
 *
 * The order of `treeNames` is the order picks are written into a code. Two
 * apps listing an aircraft's trees differently produce different strings for
 * the same build.
 */
export interface AircraftSystems {
  slug: string;
  treeNames: string[];
}

/**
 * Enough of an upgrade tree to place and gate a tier, and no more. What an
 * upgrade is called and what it does to a stat does not affect what a build
 * code says, so it lives in the app that cares.
 *
 * Field names are the wiki dataset's own, so a tree read straight out of
 * upgrades.json satisfies these with no adapter:
 *
 *   interface RichTier extends UpgradeTier { paths: RichOption[] }
 *   interface RichOption extends UpgradePathOption { name: string; effects: Effect[] }
 */
export interface UpgradePathOption {
  tier: number;
  /** "only" below the first split, "top" or "bot" at and above it. */
  path: string;
}

export interface UpgradeTier {
  tier: number;
  requires_aircraft_level: number;
  /** Two entries means the tier splits and the pick carries a branch letter. */
  paths: UpgradePathOption[];
}

export interface UpgradeTree {
  tiers: UpgradeTier[];
}

export interface CodecDataset {
  /** Key order is the data's tree order, used when deriving a code for a tree
   *  that isn't in the frozen table. */
  trees: Readonly<Record<string, UpgradeTree>>;
  aircraft: readonly AircraftSystems[];
  /** Levels clamp into [1, this]. */
  maxAircraftLevel: number;
}

/**
 * The tree codes that appear in every build code.
 *
 * These started out derived from each tree's initials, which also meant that
 * renaming a tree, or adding one whose initials collide, would silently move a
 * code and repoint every link carrying it. A build code is a public contract,
 * so the twelve that exist are written down and cannot move.
 */
const FROZEN_TREE_CODES: Readonly<Record<string, string>> = {
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

/** A Map, so a tree named "constructor" can't reach up the prototype chain. */
const frozen: ReadonlyMap<string, string> = new Map(Object.entries(FROZEN_TREE_CODES));

/**
 * Every frozen code stays reserved whether or not a dataset still has the
 * tree, so a tree the game adds later can never inherit a retired code and
 * make an old link ambiguous.
 */
const RESERVED: readonly string[] = Object.values(FROZEN_TREE_CODES);

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

const deriveCode = (name: string, taken: ReadonlySet<string>): string => {
  const letters = name.replace(/[^A-Za-z]/g, "").toUpperCase();
  const stem = initialsOf(name);
  let code = stem;
  for (let extra = 1; taken.has(code) && extra <= letters.length; extra++) {
    code = stem + letters.slice(0, extra);
  }
  return code;
};

/**
 * The frozen code where there is one, a derived code otherwise. Derivation is
 * the fallback for a tree the game adds, so nobody has to choose a code by
 * hand.
 */
export function treeCodesFor(treeNames: readonly string[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>(RESERVED);
  for (const name of treeNames) {
    const code = frozen.get(name) ?? deriveCode(name, taken);
    taken.add(code);
    out.set(name, code);
  }
  return out;
}

export const maxTierAtLevel = (tree: UpgradeTree, level: number): number =>
  tree.tiers.reduce(
    (max, tier) => (tier.requires_aircraft_level <= level ? Math.max(max, tier.tier) : max),
    0,
  );

/** Split tiers up to and including `tier`. One branch letter each. */
export const splitTiersUpTo = (tree: UpgradeTree, tier: number): number[] =>
  tree.tiers.filter((t) => t.tier <= tier && t.paths.length > 1).map((t) => t.tier);

/**
 * PRESERVED QUIRK: this is a read side rule only.
 *
 * `write` will encode more than four builds, and the extras are dropped when
 * the string is read back. Capping the writer would change what a link with
 * five builds in it looks like, so the asymmetry has to stay. It is the one
 * round trip in the test suite that is deliberately not stable.
 *
 * Owned here rather than passed in by a caller, so two apps cannot disagree
 * about how much of a link to read.
 */
export const MAX_BUILDS = 4;

/**
 * PRESERVED QUIRK: the tier capture is a single digit, which caps the format
 * at tier 9.
 *
 * The game's trees stop at 8, so nothing is lost today. A tenth tier needs a
 * format decision rather than a wider character class: `(\d)` becoming `(\d+)`
 * would make "F12" ambiguous with a tier 1 pick whose data got mangled, and
 * would change how existing strings parse. A tier 9 pick parses and is then
 * clamped down to whatever the aircraft's level allows.
 */
const PICK_RE = /^([A-Z]+)(\d)([tb]*)$/;

export interface BuildCodec {
  readonly treeCodes: ReadonlyMap<string, string>;
  readonly maxAircraftLevel: number;
  readonly maxBuilds: number;
  write(builds: readonly Build[]): string;
  /** Never throws. Degrades to a smaller valid result. */
  read(raw: string | null | undefined): Build[];
  clamp(build: Build): Build;
}

/**
 * `clamp` is exposed because it is part of what reading means, and because
 * anything constructing a Build by hand needs the same gate before encoding or
 * it can produce a code that decodes to something else.
 */
export function createBuildCodec(dataset: CodecDataset): BuildCodec {
  const treeNames = Object.keys(dataset.trees);
  const treeCodes = treeCodesFor(treeNames);
  const treeByCode: ReadonlyMap<string, string> = new Map(
    [...treeCodes].map(([name, code]) => [code, name] as const),
  );
  const systemsBySlug: ReadonlyMap<string, string[]> = new Map(
    dataset.aircraft.map((jet) => [jet.slug, jet.treeNames] as const),
  );
  const maxAircraftLevel = dataset.maxAircraftLevel;

  const treeOf = (name: string): UpgradeTree | undefined =>
    Object.prototype.hasOwnProperty.call(dataset.trees, name)
      ? dataset.trees[name]
      : undefined;

  /**
   * Lowering the level lowers every tier it no longer reaches, so a decoded
   * build is never one the game would refuse. Branch letters are trimmed to
   * the number of split tiers reached and padded with "t", so a short or over
   * long `paths` becomes a legal one instead of an error.
   *
   * Walking the aircraft's own tree order is what makes the encoded pick order
   * stable no matter how the caller assembled the record.
   */
  const clamp = (build: Build): Build => {
    const treeNamesForJet = systemsBySlug.get(build.slug);
    const level = Math.min(
      maxAircraftLevel,
      Math.max(1, Math.round(build.level) || 1),
    );
    if (treeNamesForJet === undefined) return { ...build, level, picks: {} };
    const optimised = build.optimised === true;

    const picks: Record<string, BuildPick> = {};
    for (const name of treeNamesForJet) {
      const tree = treeOf(name);
      if (tree === undefined) continue;
      const pick = build.picks[name];
      if (pick === undefined) continue;
      const tier = Math.max(
        0,
        Math.min(Math.round(pick.tier) || 0, maxTierAtLevel(tree, level)),
      );
      if (tier === 0) continue;
      const splits = splitTiersUpTo(tree, tier).length;
      const paths = pick.paths.slice(0, splits).padEnd(splits, "t");
      picks[name] = { tier, paths };
    }
    return { slug: build.slug, level, picks, optimised };
  };

  /**
   * `f-5-tiger.18.F8tttt_E6tb_A4*su-27-flanker.20.F8bbbb`
   *
   * Builds separated by `*`, then slug, level and picks by `.`, then one pick
   * per system joined by `_`. Every separator survives form encoding
   * unescaped, so four builds stay something a person can paste into a comment
   * rather than a wall of %2C.
   *
   * The trailing `.o` is appended rather than woven in, so links written
   * before the flag existed still read, and a reader that does not know about
   * it still gets the right build.
   */
  const write = (builds: readonly Build[]): string =>
    builds
      .map((build) => {
        const picks = Object.entries(build.picks)
          .filter(([, pick]) => pick.tier > 0)
          .map(([name, pick]) => `${treeCodes.get(name) ?? ""}${pick.tier}${pick.paths}`)
          // PRESERVED QUIRK: this reads like a length guard and is really an
          // unknown tree drop. A tree the dataset has never heard of gets ""
          // from the lookup above, so its segment is a bare tier digit, one
          // character, and is discarded here. Every real pick is at least a
          // code plus a digit, so nothing else can trip it. Remove this and an
          // unknown tree encodes as a lone digit that reads back as nothing,
          // and the string stops round tripping.
          .filter((text) => text.length > 1)
          .join("_");
        const flag = build.optimised === true ? ".o" : "";
        // An optimised build always has picks. The empty segment keeps the
        // grammar positional rather than relying on that.
        return `${build.slug}.${build.level}${picks === "" && flag === "" ? "" : `.${picks}`}${flag}`;
      })
      .join("*");

  /**
   * Nothing is trusted. An unknown aircraft or system is dropped, a tier above
   * what the level allows is lowered to it, and a missing branch letter reads
   * as the first branch. A stale link degrades to a smaller valid build rather
   * than an error.
   */
  const read = (raw: string | null | undefined): Build[] => {
    if (raw === null || raw === undefined || raw.trim() === "") return [];
    const out: Build[] = [];
    for (const chunk of raw.split("*")) {
      const [slug, rawLevel, rawPicks, rawFlag] = chunk.split(".");
      if (slug === undefined || !systemsBySlug.has(slug)) continue;
      const level = Number(rawLevel);
      const picks: Record<string, BuildPick> = {};
      for (const part of (rawPicks ?? "").split("_")) {
        const match = PICK_RE.exec(part);
        if (match === null) continue;
        const name = treeByCode.get(match[1]);
        if (name === undefined) continue;
        picks[name] = { tier: Number(match[2]), paths: match[3] };
      }
      out.push(
        clamp({
          slug,
          level: Number.isFinite(level) ? level : maxAircraftLevel,
          picks,
          optimised: rawFlag === "o",
        }),
      );
      if (out.length >= MAX_BUILDS) break;
    }
    return out;
  };

  return { treeCodes, maxAircraftLevel, maxBuilds: MAX_BUILDS, write, read, clamp };
}
