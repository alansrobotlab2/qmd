/**
 * The in-memory vector index is defined by one property: it returns what
 * sqlite-vec returns, faster. Every test here is a comparison against the
 * sqlite-vec path it replaces, on the same table, with the index switched on
 * and off through the same environment variable the daemon would use.
 */
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore, insertEmbedding, type Store } from "../src/store.ts";
import { VecIndex, type VecIndexLoader } from "../src/vecindex.ts";

const DIMS = 8;
let dir: string;
const open: Store[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "qmd-vecindex-"));
});

afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  delete process.env.QMD_VEC_MEMORY_INDEX;
  delete process.env.QMD_VEC_MEMORY_INDEX_MAX_VECTORS;
  await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(join(tmpdir(), "qmd-vecindex-"));
});

function newStore(name = "idx"): Store {
  const store = createStore(join(dir, `${name}.sqlite`));
  open.push(store);
  store.ensureVecTable(DIMS);
  return store;
}

/** Deterministic unit-ish vector: angle `a` in the first two dims, noise after. */
function vec(a: number, seed = 0): Float32Array {
  const v = new Float32Array(DIMS);
  v[0] = Math.cos(a);
  v[1] = Math.sin(a);
  for (let j = 2; j < DIMS; j++) v[j] = Math.sin(seed * 7.1 + j) * 0.05;
  return v;
}

function addDoc(store: Store, collection: string, name: string, embedding: Float32Array, seq = 0) {
  const hash = `${collection}-${name}`.replace(/[^a-z0-9-]/gi, "");
  const now = new Date().toISOString();
  if (seq === 0) {
    store.insertContent(hash, `Body of ${name} in ${collection}`, now);
    store.insertDocument(collection, `${name}.md`, name, hash, now, now);
  }
  insertEmbedding(store.db, hash, seq, seq * 100, embedding, "test-model", now);
  return hash;
}

const q = Array.from(vec(0.3));

async function bothWays(store: Store, limit: number, collection?: string | string[]) {
  process.env.QMD_VEC_MEMORY_INDEX = "1";
  const withIndex = await store.searchVec("ignored", "test-model", limit, collection, undefined, q);
  process.env.QMD_VEC_MEMORY_INDEX = "0";
  const withoutIndex = await store.searchVec("ignored", "test-model", limit, collection, undefined, q);
  return { withIndex, withoutIndex };
}

describe("VecIndex against sqlite-vec", () => {
  test("global and collection-scoped results are identical, in order", async () => {
    const store = newStore();
    for (let i = 0; i < 120; i++) addDoc(store, i % 3 === 0 ? "alpha" : i % 3 === 1 ? "beta" : "gamma", `d${i}`, vec(i * 0.11, i));

    for (const scope of [undefined, "alpha", "gamma", ["alpha", "beta"]] as const) {
      const { withIndex, withoutIndex } = await bothWays(store, 7, scope as string | string[] | undefined);
      expect(withIndex.map((r) => r.filepath)).toEqual(withoutIndex.map((r) => r.filepath));
      for (let i = 0; i < withIndex.length; i++) {
        expect(withIndex[i]!.score).toBeCloseTo(withoutIndex[i]!.score, 5);
        expect(withIndex[i]!.body).toBe(withoutIndex[i]!.body);
        expect(withIndex[i]!.chunkPos).toBe(withoutIndex[i]!.chunkPos);
      }
    }
  });

  test("a small collection crowded by a large one is still found (#791, #803)", async () => {
    // Same shape as the sqlite-vec exact-scan test: 250 nearer neighbours in
    // `large`, one farther target in `small`. The global top-k never contains
    // it; the collection-scoped search must.
    const store = newStore();
    for (let i = 0; i < 250; i++) addDoc(store, "large", `noise${i}`, vec(0.3 + (i % 10) * 0.001, i));
    addDoc(store, "small", "target", vec(1.2));
    process.env.QMD_VEC_MEMORY_INDEX = "1";
    const scoped = await store.searchVec("ignored", "test-model", 3, "small", undefined, q);
    expect(scoped.map((r) => r.displayPath)).toEqual(["small/target.md"]);
    const global = await store.searchVec("ignored", "test-model", 3, undefined, undefined, q);
    expect(global.every((r) => r.collectionName === "large")).toBe(true);
  });

  test("multi-chunk documents collapse to one result at their best chunk", async () => {
    const store = newStore();
    const hash = addDoc(store, "alpha", "long", vec(2.0), 0);
    insertEmbedding(store.db, hash, 1, 100, vec(0.31), "test-model", new Date().toISOString()); // the near chunk
    addDoc(store, "alpha", "other", vec(1.0));
    const { withIndex, withoutIndex } = await bothWays(store, 5, "alpha");
    expect(withIndex.map((r) => [r.displayPath, r.chunkPos])).toEqual(withoutIndex.map((r) => [r.displayPath, r.chunkPos]));
    expect(withIndex[0]).toMatchObject({ displayPath: "alpha/long.md", chunkPos: 100 });
    expect(withIndex).toHaveLength(2);
  });

  test("an in-process write is seen by the next search without a manual invalidate", async () => {
    const store = newStore();
    process.env.QMD_VEC_MEMORY_INDEX = "1";
    addDoc(store, "alpha", "far", vec(2.5));
    let hits = await store.searchVec("ignored", "test-model", 1, undefined, undefined, q);
    expect(hits[0]!.displayPath).toBe("alpha/far.md");
    addDoc(store, "alpha", "near", vec(0.3));
    hits = await store.searchVec("ignored", "test-model", 1, undefined, undefined, q);
    expect(hits[0]!.displayPath).toBe("alpha/near.md");
  });

  test("a deactivated document leaves the partition", async () => {
    const store = newStore();
    process.env.QMD_VEC_MEMORY_INDEX = "1";
    addDoc(store, "alpha", "near", vec(0.3));
    addDoc(store, "alpha", "far", vec(2.5));
    expect((await store.searchVec("ignored", "test-model", 1, "alpha", undefined, q))[0]!.displayPath).toBe("alpha/near.md");
    store.deactivateDocument("alpha", "near.md");
    expect((await store.searchVec("ignored", "test-model", 1, "alpha", undefined, q))[0]!.displayPath).toBe("alpha/far.md");
  });

  test("a write through another connection is seen (PRAGMA data_version)", async () => {
    const store = newStore("shared");
    process.env.QMD_VEC_MEMORY_INDEX = "1";
    addDoc(store, "alpha", "far", vec(2.5));
    expect((await store.searchVec("ignored", "test-model", 1, undefined, undefined, q))[0]!.displayPath).toBe("alpha/far.md");

    const writer = createStore(store.dbPath); // the daemon's situation: some other process embeds
    open.push(writer);
    addDoc(writer, "alpha", "near", vec(0.3));

    expect((await store.searchVec("ignored", "test-model", 1, undefined, undefined, q))[0]!.displayPath).toBe("alpha/near.md");
  });

  test("above the vector cap it steps aside for sqlite-vec, with the same answer", async () => {
    process.env.QMD_VEC_MEMORY_INDEX_MAX_VECTORS = "5";
    const store = newStore("capped");
    for (let i = 0; i < 40; i++) addDoc(store, "alpha", `d${i}`, vec(i * 0.2, i));
    const { withIndex, withoutIndex } = await bothWays(store, 5, "alpha");
    expect(withIndex.map((r) => r.filepath)).toEqual(withoutIndex.map((r) => r.filepath));
  });
});

describe("VecIndex unit", () => {
  function loader(rows: { id: string; v: number[]; colls: string[] }[], version = { n: 1 }): VecIndexLoader {
    return {
      vectors: () => rows.map((r) => ({ hash_seq: r.id, embedding: new Float32Array(r.v) })),
      memberships: () => rows.flatMap((r) => r.colls.map((collection) => ({ hash_seq: r.id, collection }))),
      dataVersion: () => version.n,
    };
  }

  test("per-collection search is exact and distances are cosine", () => {
    const rows = [
      { id: "a_0", v: [1, 0], colls: ["x"] },
      { id: "b_0", v: [0.6, 0.8], colls: ["x", "y"] },
      { id: "c_0", v: [0, 1], colls: ["y"] },
      { id: "d_0", v: [-1, 0], colls: ["y"] },
    ];
    const index = new VecIndex(loader(rows));
    expect(index.ensureFresh()).toBe(true);
    expect(index.search([1, 0], 2, "x").map((h) => h.hash_seq)).toEqual(["a_0", "b_0"]);
    expect(index.search([1, 0], 2, "y").map((h) => h.hash_seq)).toEqual(["b_0", "c_0"]);
    expect(index.search([1, 0], 2, "missing")).toEqual([]);
    expect(index.search([1, 0], 2, "x")[0]!.distance).toBeCloseTo(0, 6);
    expect(index.search([1, 0], 2, "x")[1]!.distance).toBeCloseTo(1 - 0.6, 6);
    expect(index.search([1, 0], 10).map((h) => h.hash_seq)).toEqual(["a_0", "b_0", "c_0", "d_0"]);
  });

  test("large k takes the sort path and agrees with the insertion path", () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: `r${i}`, v: [Math.cos(i * 0.37), Math.sin(i * 0.37)], colls: ["c"] }));
    const index = new VecIndex(loader(rows));
    index.ensureFresh();
    const small = index.search([1, 0], 50).map((h) => h.hash_seq);
    const large = index.search([1, 0], 300).map((h) => h.hash_seq);
    expect(large.slice(0, 50)).toEqual(small);
  });

  test("reloads when the version moves or invalidate() is called, not otherwise", () => {
    const version = { n: 1 };
    let loads = 0;
    const base = loader([{ id: "a_0", v: [1, 0], colls: ["x"] }], version);
    const counting: VecIndexLoader = { ...base, vectors: () => (loads++, base.vectors()) };
    const index = new VecIndex(counting);
    index.ensureFresh();
    index.ensureFresh();
    expect(loads).toBe(1);
    version.n = 2;
    index.ensureFresh();
    expect(loads).toBe(2);
    index.invalidate();
    index.ensureFresh();
    expect(loads).toBe(3);
  });

  test("refuses to build above the cap and remembers the refusal", () => {
    let loads = 0;
    const base = loader([{ id: "a_0", v: [1, 0], colls: ["x"] }, { id: "b_0", v: [0, 1], colls: ["x"] }]);
    const counting: VecIndexLoader = { ...base, vectors: () => (loads++, base.vectors()) };
    const index = new VecIndex(counting, 1);
    expect(index.ensureFresh()).toBe(false);
    expect(index.ensureFresh()).toBe(false);
    expect(loads).toBe(1);
    expect(index.search([1, 0], 1)).toEqual([]);
  });
});

describe("multi-collection scoring", () => {
  /**
   * There used to be a `searchPartitioned` here — top-k per collection from
   * one scan — written, tested and called by nothing. It looked like a missed
   * optimisation and was not one: `scores()` memoises on the query vector, so
   * the twelve recursions of a twelve-collection search already share a
   * single pass. Rewiring the recursion to use it measured 27.2 ms against
   * 27.6 ms on the live 21k-vector index — noise — so it was deleted rather
   * than kept as a second way to do the same thing.
   *
   * What is worth keeping is the coverage. The parity test above stops at two
   * collections; the real client fans out over twelve.
   */
  test("twelve collections give identical results with the index on and off", async () => {
    const store = newStore("multi");
    const names = Array.from({ length: 12 }, (_, i) => `c${i}`);
    names.forEach((c, i) => {
      for (let j = 0; j < 5; j++) addDoc(store, c, `d${i}_${j}`, vec(i * 0.2 + j * 0.01, i * 10 + j));
    });

    const { withIndex, withoutIndex } = await bothWays(store, 9, names);
    expect(withIndex.map((r) => r.filepath)).toEqual(withoutIndex.map((r) => r.filepath));
    for (let i = 0; i < withIndex.length; i++) {
      expect(withIndex[i]!.score).toBeCloseTo(withoutIndex[i]!.score, 5);
    }
  });
});
