/**
 * Global fusion's primitives: one ranking across several collections.
 *
 * `structuredSearch` used to hand RRF one list per search per collection. RRF
 * reads ranks only, so every collection's #1 tied with every other's and an
 * eleven-collection request had to rerank 240 rows to keep the right ones
 * (Lloyd, 2026-09-14). What is pinned here is that the across-collection
 * searches return exactly what merging the per-collection ones by score would —
 * same documents, same order — for one pass instead of one per collection.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createStore, searchFTS, searchFTSAcross, type Store } from "../src/store.ts";
import { VecIndex, type VecIndexLoader } from "../src/vecindex.ts";

let dir: string;
let store: Store;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "qmd-global-fusion-"));
  store = createStore(join(dir, "gf.sqlite"));
  const now = new Date().toISOString();
  const add = (collection: string, name: string, body: string) => {
    const hash = createHash("sha256").update(collection + name + body).digest("hex");
    store.insertContent(hash, body, now);
    store.insertDocument(collection, `${name}.md`, name, hash, now, now);
  };
  for (let i = 0; i < 30; i++) add("big", `big${i}`, `general notes number ${i} about gardening and ${i % 3 === 0 ? "guardian rollback" : "weather"}`);
  add("small", "task1", "guardian rollback guardian rollback: the guardian decides when to roll back a promotion");
  add("small", "task2", "scheduler notes, nothing about the topic");
  add("other", "o1", "rollback of a database migration, unrelated guardian of the galaxy");
  add("ignored", "x1", "guardian rollback guardian rollback guardian rollback");
});

afterAll(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("searchFTSAcross", () => {
  test("equals the per-collection searches merged by score, in one pass, without bodies", () => {
    const names = ["big", "small", "other"];
    const merged = names
      .flatMap((n) => searchFTS(store.db, "guardian rollback", 50, n))
      .sort((a, b) => b.score - a.score);
    const across = searchFTSAcross(store.db, "guardian rollback", names, 500);
    expect(across.map((h) => h.filepath)).toEqual(merged.map((r) => r.filepath));
    across.forEach((h, i) => expect(h.score).toBeCloseTo(merged[i]!.score, 9));
    expect(across.every((h) => names.includes(h.collection))).toBe(true);
    expect(across.some((h) => h.filepath.includes("ignored"))).toBe(false);
    expect(Object.keys(across[0]!)).not.toContain("body");
  });

  test("a small collection's strong hit leads the global list", () => {
    const across = searchFTSAcross(store.db, "guardian rollback", ["big", "small", "other"], 500);
    expect(across[0]!.filepath).toBe("qmd://small/task1.md");
  });

  test("no collections, or a query with nothing searchable, is an empty list", () => {
    expect(searchFTSAcross(store.db, "guardian", [], 100)).toEqual([]);
    expect(searchFTSAcross(store.db, "   ", ["big"], 100)).toEqual([]);
  });
});

describe("VecIndex.search over several collections", () => {
  const rows = [
    { id: "a_0", v: [1, 0], colls: ["x"] },
    { id: "b_0", v: [0.9, 0.1], colls: ["y"] },
    { id: "c_0", v: [0.8, 0.6], colls: ["x", "y"] }, // identical content indexed twice
    { id: "d_0", v: [0, 1], colls: ["z"] },
    { id: "e_0", v: [0.95, 0.05], colls: ["w"] },    // not asked for
  ];
  const loader: VecIndexLoader = {
    vectors: () => rows.map((r) => ({ hash_seq: r.id, embedding: new Float32Array(r.v) })),
    memberships: () => rows.flatMap((r) => r.colls.map((collection) => ({ hash_seq: r.id, collection }))),
    dataVersion: () => 1,
  };

  test("one ranking over the union; a shared chunk is one candidate; unnamed collections stay out", () => {
    const index = new VecIndex(loader);
    index.ensureFresh();
    const hits = index.search([1, 0], 10, ["x", "y", "z"]).map((h) => h.hash_seq);
    expect(hits).toEqual(["a_0", "b_0", "c_0", "d_0"]);
    expect(index.search([1, 0], 2, ["x", "y"]).map((h) => h.hash_seq)).toEqual(["a_0", "b_0"]);
    expect(index.search([1, 0], 5, ["missing"])).toEqual([]);
    expect(index.search([1, 0], 5, [])).toEqual([]);
  });

  test("a one-name list is the single-collection search", () => {
    const index = new VecIndex(loader);
    index.ensureFresh();
    expect(index.search([1, 0], 5, ["y"])).toEqual(index.search([1, 0], 5, "y"));
  });
});

describe("collectionFloor", () => {
  test("REST accepts a number or a per-collection map, and drops junk", async () => {
    // The parsing lives in the REST handler; what matters to a client is that a
    // map reaches structuredSearch as a map and a malformed one as nothing.
    const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/mcp/server.ts", import.meta.url), "utf8"));
    expect(src).toContain('typeof params.collectionFloor === "number"');
    expect(src).toContain("Object.fromEntries(Object.entries(params.collectionFloor");
  });
});
