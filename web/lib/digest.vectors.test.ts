/**
 * lib/digest.vectors.test.ts — cross-implementation digest parity gate.
 *
 * Asserts the TypeScript canon()/computeHash() port reproduces EVERY vector in
 * the repo's shared golden testdata/digest_vectors.json (the same file the Go
 * and Python tests pin). If this drifts, the browser-side "anyone can
 * recompute" guarantee is broken — so this must stay green.
 *
 * Runner-agnostic: uses Node's built-in `node:test` + `node:assert` (no extra
 * deps). Run via:  node --test --experimental-strip-types lib/digest.vectors.test.ts
 * (Node ≥ 23 strips TS types natively). A plain-JS equivalent that needs no TS
 * loader lives in scripts/digest-check.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { canonHex, computeHash } from "./digest.ts";
import type { EvidenceRecord } from "./types.ts";

interface Vector {
  name: string;
  record: EvidenceRecord;
  canon_hex: string;
  hash: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenPath = path.join(here, "..", "..", "testdata", "digest_vectors.json");
const golden: Vector[] = JSON.parse(readFileSync(goldenPath, "utf8"));

test("digest vectors: golden file is non-empty", () => {
  assert.ok(golden.length > 0, "expected at least one vector");
});

for (const v of golden) {
  test(`canon matches golden — ${v.name}`, () => {
    assert.equal(canonHex(v.record), v.canon_hex);
  });

  test(`hash matches golden — ${v.name}`, async () => {
    const got = await computeHash(v.record);
    assert.equal(got, v.hash);
    assert.equal(got.length, 64);
  });
}
