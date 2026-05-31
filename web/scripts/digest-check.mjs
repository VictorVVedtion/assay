/**
 * scripts/digest-check.mjs — standalone cross-impl digest parity check.
 *
 * No test framework, no TS loader assumptions beyond Node's native type
 * stripping (Node ≥ 22.6 with --experimental-strip-types; ≥ 23 by default).
 * Verifies lib/digest.ts reproduces every vector in testdata/digest_vectors.json
 * and exits non-zero on any mismatch — suitable as a CI gate.
 *
 *   node web/scripts/digest-check.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { canonHex, computeHash } = await import(
  path.join(here, "..", "lib", "digest.ts")
);

const goldenPath = path.join(here, "..", "..", "testdata", "digest_vectors.json");
const golden = JSON.parse(readFileSync(goldenPath, "utf8"));

let failures = 0;
for (const v of golden) {
  const gotCanon = canonHex(v.record);
  const gotHash = await computeHash(v.record);
  const canonOk = gotCanon === v.canon_hex;
  const hashOk = gotHash === v.hash;
  if (canonOk && hashOk) {
    console.log(`  ok    ${v.name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${v.name}`);
    if (!canonOk) {
      console.error(`        canon got  ${gotCanon}`);
      console.error(`        canon want ${v.canon_hex}`);
    }
    if (!hashOk) {
      console.error(`        hash  got  ${gotHash}`);
      console.error(`        hash  want ${v.hash}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${golden.length} digest vector(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${golden.length} digest vectors pass`);
