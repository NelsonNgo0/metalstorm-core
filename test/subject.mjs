/**
 * The implementation under test, behind one seam.
 *
 * The characterisation suite is meant to be run against two different
 * implementations and give the same answer both times: the original code in
 * the portfolio repo, and this extracted package. Only this file knows which
 * one is loaded, so the assertions never move.
 *
 * It now loads the PACKAGE, from its built output, over the minimal dataset
 * recorded in the fixture. Set METALSTORM_SUBJECT=original to run the exact
 * same assertions against the code the fixture was recorded from. That is the
 * comparison the extraction has to survive, and keeping it one environment
 * variable away means it stays runnable rather than becoming a story about
 * what was checked once.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

let server = null;

/**
 * The original, loaded through Vite's SSR pipeline the way the site builds it.
 *
 * Only works from inside the portfolio repo, which is the only place the
 * original implementation and the wiki data exist. Once this package lives in
 * its own repository this path is unrunnable, so it says so plainly rather
 * than failing as a module-not-found three frames deep.
 */
async function loadOriginal(fixture) {
  let createServer;
  try {
    ({ createServer } = await import("vite"));
  } catch {
    throw new Error(
      "METALSTORM_SUBJECT=original needs the v02 portfolio repo: it loads the " +
        "pre-extraction implementation from src/metalstorm/builds.ts through " +
        "Vite. Run it from a checkout of that repo, or drop the variable to " +
        "test this package (the default).",
    );
  }
  server = await createServer({
    root: repoRoot,
    appType: "custom",
    server: { middlewareMode: true, hmr: false },
    logLevel: "warn",
  });

  const builds = await server.ssrLoadModule("/src/metalstorm/builds.ts");
  const MAX_BUILDS = fixture.constants.MAX_BUILDS;

  return {
    write: (list) => builds.writeBuilds(list),
    read: (raw) => builds.readBuilds(raw, MAX_BUILDS),
    treeCodes: Object.fromEntries(builds.treeCodes),
    MAX_BUILDS,
    MAX_AIRCRAFT_LEVEL: builds.MAX_AIRCRAFT_LEVEL,
    SPLIT_FROM: builds.SPLIT_FROM,
  };
}

/** The package, over the minimal dataset the fixture carries. */
async function loadPackage(fixture) {
  const core = await import("../dist/index.js");
  const codec = core.createBuildCodec(fixture.dataset);

  // SPLIT_FROM is a fact about the trees rather than something the codec
  // owns, so it is measured off the dataset here rather than asked of the
  // package. The suite still checks it, because a dataset whose trees started
  // splitting somewhere else would change every code.
  const firstTree = Object.values(fixture.dataset.trees)[0];
  const splitFrom = firstTree.tiers.find((t) => t.paths.length > 1)?.tier ?? 5;

  return {
    write: (list) => codec.write(list),
    read: (raw) => codec.read(raw),
    treeCodes: Object.fromEntries(codec.treeCodes),
    MAX_BUILDS: codec.maxBuilds,
    MAX_AIRCRAFT_LEVEL: codec.maxAircraftLevel,
    SPLIT_FROM: splitFrom,
  };
}

export async function loadCodec(fixture) {
  return process.env.METALSTORM_SUBJECT === "original"
    ? loadOriginal(fixture)
    : loadPackage(fixture);
}

export async function dispose() {
  if (server !== null) {
    await server.close();
    server = null;
  }
}
