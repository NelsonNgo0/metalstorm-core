# @v02/metalstorm-core

The MetalStorm build code format, and the types two apps need to agree on to
share one.

## The format

A build code is the string in `?b=`:

```
f-5-tiger.18.F8tttt_E6tb_A4*su-27-flanker.20.F8bbbb
```

Builds are separated by `*`. Within a build, slug, level and picks are
separated by `.`. Picks are joined by `_`.

One pick is a tree code, a tier digit, and one branch letter per split tier:
`t` for the top branch, `b` for the bottom. A tier below the first split
carries no letters, so `A4` is tier 4 with nothing to choose, `E6tb` is tier 6
having taken top at tier 5 and bottom at tier 6, and `F8tttt` is tier 8 with
four choices made.

A trailing `.o` marks a build whose forks came from a weighting rather than
from hand picking. It is appended rather than woven in, so links written before
the flag existed still read.

Every separator survives form encoding unescaped, so four builds stay something
a person can paste into a comment.

People bookmark these. The format is frozen. A code written today has to keep
decoding to the same build for as long as anyone might click it.

## Install

```bash
npm install @v02/metalstorm-core
```

No runtime dependencies. ESM plus type declarations. The tsconfig's `lib` is
`ES2022` and nothing else, so the package cannot reach for `document` or
`process` by accident. It imports the same way into a Vite web app and an
Electron main process.

## Use

Reading a code is not a pure string operation. It validates and re-seats the
result against real data: unknown aircraft are dropped, a tier above what the
level allows is lowered to it, missing branch letters are filled in. So the
codec is built over a dataset you inject.

```ts
import { createBuildCodec } from "@v02/metalstorm-core";

const codec = createBuildCodec({ trees, aircraft, maxAircraftLevel: 20 });

codec.write(builds); // "f-5-tiger.18.F8tttt_..."
codec.read(raw);     // Build[], never throws
codec.clamp(build);  // a build the game would actually allow
```

Both apps build that dataset from their own copy of the wiki data. Same data
in, same bytes out. Different data in, and the two will disagree, which is a
failure you can see rather than one that hides.

### The dataset you supply

This is the whole contract. If a field does not decide what a build code says
or whether a build is legal, it is not here. No stats, no percentiles, no
effects, no labels, no images.

```ts
interface CodecDataset {
  /** Upgrade trees by name. Key order is the data's tree order. */
  trees: Readonly<Record<string, UpgradeTree>>;
  aircraft: readonly AircraftSystems[];
  /** Levels clamp into [1, this]. */
  maxAircraftLevel: number;
}

interface AircraftSystems {
  slug: string;
  /** In the aircraft's own tree order. This is load bearing, see below. */
  treeNames: string[];
}

interface UpgradeTree { tiers: UpgradeTier[] }

interface UpgradeTier {
  tier: number;
  requires_aircraft_level: number;
  /** Two entries means the tier splits and the pick carries a branch letter. */
  paths: UpgradePathOption[];
}

interface UpgradePathOption {
  tier: number;
  /** "only" below the first split, "top" or "bot" at and above it. */
  path: string;
}
```

Field names are the wiki dataset's own, so a tree read straight out of
`upgrades.json` satisfies these with no adapter in between.

Which trees an aircraft carries is derived from its loadout. Each weapon row
names an upgrade tree, and three trees apply to every airframe. That derivation
stays in whichever app owns the data. This package never sees a weapon.

### Two things that are load bearing

**Tree order.** `AircraftSystems.treeNames` is the order picks are written into
a code. Two apps listing an aircraft's trees differently produce different
strings for the same build.

**Pick insertion order.** `Build.picks` is a record, and its insertion order is
what `write` emits. Run a hand built `Build` through `clamp` before encoding.
It rebuilds the record in the aircraft's own tree order.

## Narrow on purpose

The types here cover identity, a build, the upgrade skeleton needed to place
and gate a tier, and the code format. That is all.

What an upgrade is called, what it does to a stat, percentiles, dominance, stat
metadata: none of that affects what a build code says, so none of it is here. A
consumer that has those extends the core shapes locally.

```ts
import type { UpgradeTier, UpgradePathOption } from "@v02/metalstorm-core";

interface RichOption extends UpgradePathOption { name: string; effects: Effect[] }
interface RichTier extends UpgradeTier { paths: RichOption[] }
```

**No upgrade costs.** What a tier charges, in what currency, and how that
scales is not modelled here and is not in the source dataset either. The wiki
does not publish it in usable form, and Starform's own planner answers it for a
signed in pilot. Nothing here should grow a placeholder for it.

## Tree codes are frozen

These twelve appear verbatim in every shared link, so they are written down
rather than derived:

| Code | Tree | | Code | Tree |
|---|---|---|---|---|
| `F` | Fuselage | | `ACP` | Assault Cannon Pods |
| `E` | Engines | | `R` | Rockets |
| `A` | Avionics | | `IM` | Infrared Missiles |
| `PC` | Precision Cannons | | `MM` | Manual Missiles |
| `AC` | Assault Cannons | | `RM` | Radar Missiles |
| `PCP` | Precision Cannon Pods | | `BRM` | Beam Riding Missiles |

They started out derived from initials at runtime, with a collision extending
the code using more of the tree's own letters. "Precision Cannon Pods" is PCP.
That also meant renaming a tree, or adding one whose initials collide, could
silently move a code and repoint every link carrying it. So the twelve that
exist are written down and cannot move.

The derivation survives as the fallback for a tree that is not in the table, so
a tree the game adds still gets a code without anyone choosing one.

**All twelve codes are reserved permanently**, whether or not a dataset still
contains the tree. A tree the data drops keeps its code out of circulation, so
a new tree can never inherit a retired one and an old link can never become
ambiguous. `F` means Fuselage for good.

## Three preserved quirks

All three are deliberate. Changing any one of them changes what a string means.

**1. The length filter in `write`** looks like a guard against short segments
and is really an unknown tree drop. A tree the dataset has never heard of gets
an empty code from the lookup, so its segment is a bare tier digit, one
character, and is discarded. Every real pick is at least a code plus a digit,
so nothing else can trip it. Remove it and an unknown tree encodes as a lone
digit that reads back as nothing, and the string stops round tripping.

**2. `PICK_RE` captures a single digit**, capping the format at tier 9. The
game's trees stop at 8, so nothing is lost today. A tenth tier needs a format
decision rather than a wider character class: `(\d)` becoming `(\d+)` would
make `F12` ambiguous with a mangled tier 1 pick, and would change how existing
strings parse. A tier 9 pick parses and is then clamped down to whatever the
aircraft's level allows.

**3. `MAX_BUILDS` is a read side rule only.** `read` returns at most four
builds. `write` will encode more, and the extras are dropped when the string is
read back. Capping the writer would change what a link containing five builds
looks like. This is the one round trip in the suite that is deliberately not
stable, and it is listed there by name so a new instability cannot hide behind
a blanket exemption.

## Tests

```bash
npm test
```

The suite is characterisation. Every expectation is a recording of what the
shipped implementation actually produced: 437 assertions over all 43 aircraft,
all twelve tree codes, multi build strings, the `.o` flag, level and tier
clamping, and malformed input.

`test/subject.mjs` is a seam. By default it tests this package. With
`METALSTORM_SUBJECT=original` it runs the identical assertions against the
original code in the portfolio repo that the fixture was recorded from, which
is the comparison the extraction had to survive. That path only works from
inside a checkout of that repo.

Regenerate the fixture from the portfolio repo, which owns the data:

```bash
node src/metalstorm/scripts/record-build-codes.mjs
```

Read the diff rather than accepting it. New aircraft or trees show up as new
cases. An existing code changing means a link someone bookmarked has stopped
resolving to the build they shared. Do not re-record to turn a test green.
