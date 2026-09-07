/**
 * In-memory exact vector index over `vectors_vec`.
 *
 * Why this exists. sqlite-vec 0.1.9 has no ANN structure: a `MATCH` is a
 * brute-force pass over every stored vector, and on this extension that pass
 * costs about 9 µs per 768-dim vector — ~190 ms for 21k chunks. Worse, a
 * collection-scoped search cannot push the filter into `MATCH`, so `searchVec`
 * either post-filters a global top-k (which starves small collections, #791,
 * #803) or exact-scans the collection through chunked `hash_seq IN (...)`
 * lists at ~76 µs per vector. A twelve-collection query paid the exact scan
 * twelve times: 1.2 s of the 1.3 s it took, measured 2026-09-07.
 *
 * The same dot products over a normalised Float32 matrix in JS take 12 ms for
 * the whole table, and once every vector's score is in hand, an exact top-k
 * for *each* collection is a partition of one array rather than a fresh scan.
 * Collection scoping becomes free and exact — no starvation, no over-fetch,
 * no cap on k — which is the property the exact-scan path was paying for.
 *
 * Correctness is defined against sqlite-vec: cosine distance is `1 - cos`,
 * rows are L2-normalised at load so cosine is a dot product, and the ordering
 * is identical to `MATCH` on the same table (top-60 matched position for
 * position on the live index). `vecindex.test.ts` pins that against a real
 * vec0 table.
 *
 * Freshness. The daemon never writes vectors; `qmd embed`, the watcher and
 * `qmd cleanup` commit from other connections, and `PRAGMA data_version`
 * changes on every commit made through *another* connection. In-process
 * writers (the SDK, `embed` run in the same process, tests) do not move
 * data_version, so `store.ts` bumps `invalidate()` from every path that
 * touches `vectors_vec`. Either signal forces a reload on the next search.
 * A reload is a full rebuild — ~0.5 s for 21k vectors — which is the right
 * trade while embeds are batch jobs; it is not the right trade for a
 * write-heavy index, which is one reason the memory cap exists.
 *
 * Bounds. `QMD_VEC_MEMORY_INDEX=0` disables it (the sqlite-vec paths are
 * untouched and remain the fallback). `QMD_VEC_MEMORY_INDEX_MAX_VECTORS`
 * (default 200 000, ~600 MB at 768 dims) refuses to build above that size,
 * so a large index degrades to the old behaviour instead of exhausting RAM.
 */

import type { Database } from "./db.js";

export interface VecHit {
  hash_seq: string;
  distance: number;
}

export const DEFAULT_VEC_MEMORY_INDEX_MAX_VECTORS = 200_000;

export function vecMemoryIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.QMD_VEC_MEMORY_INDEX?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

export function vecMemoryIndexMaxVectors(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.QMD_VEC_MEMORY_INDEX_MAX_VECTORS?.trim();
  if (!raw) return DEFAULT_VEC_MEMORY_INDEX_MAX_VECTORS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(
      `QMD Warning: invalid QMD_VEC_MEMORY_INDEX_MAX_VECTORS="${raw}", using ${DEFAULT_VEC_MEMORY_INDEX_MAX_VECTORS}.\n`,
    );
    return DEFAULT_VEC_MEMORY_INDEX_MAX_VECTORS;
  }
  return n;
}

/** Row shape produced by the loader; kept narrow so tests can feed it directly. */
export interface VecIndexRow {
  hash_seq: string;
  embedding: Uint8Array | ArrayBuffer | Float32Array;
}

export interface VecIndexMembership {
  hash_seq: string;
  collection: string;
}

export interface VecIndexLoader {
  /** Every row of `vectors_vec`. */
  vectors(): VecIndexRow[];
  /** (hash_seq, collection) for every active document chunk. A chunk shared by
   *  several collections (identical content indexed twice) appears once per
   *  collection, which is what a per-collection partition needs. */
  memberships(): VecIndexMembership[];
  /** Cheap change signal; the index reloads when it differs from last load. */
  dataVersion(): number;
}

interface Built {
  matrix: Float32Array; // rows L2-normalised, N * dim
  ids: string[];
  dim: number;
  byCollection: Map<string, Int32Array>;
  dataVersion: number;
  generation: number;
}

/**
 * Selection thresholds. Insertion into a bounded sorted array is O(N·k) in the
 * worst case, so above `SORT_THRESHOLD_K` a full sort of the candidate set is
 * both simpler and faster (21k indices sort in ~3 ms).
 */
const SORT_THRESHOLD_K = 256;

export class VecIndex {
  private built: Built | null = null;
  private generation = 0;
  /** Set when a build was refused (too large) so we do not retry every query. */
  private refusedAtVersion: number | null = null;
  private lastScores: { key: Float32Array; scores: Float32Array; generation: number; dataVersion: number } | null = null;

  constructor(
    private readonly loader: VecIndexLoader,
    private readonly maxVectors: number = vecMemoryIndexMaxVectors(),
  ) {}

  /** Bump after any in-process write to `vectors_vec` or document activity. */
  invalidate(): void {
    this.generation++;
    this.refusedAtVersion = null;
  }

  /** Number of vectors held, or 0 when nothing is loaded. */
  get size(): number {
    return this.built?.ids.length ?? 0;
  }

  /**
   * Load or refresh. Returns false when the index is unavailable (refused for
   * size, or empty), in which case callers must use the sqlite-vec paths.
   */
  ensureFresh(): boolean {
    const version = this.loader.dataVersion();
    if (
      this.built &&
      this.built.dataVersion === version &&
      this.built.generation === this.generation
    ) {
      return true;
    }
    if (this.refusedAtVersion === version) return false;

    const rows = this.loader.vectors();
    if (rows.length === 0) {
      this.built = null;
      return false;
    }
    if (rows.length > this.maxVectors) {
      this.refusedAtVersion = version;
      this.built = null;
      return false;
    }

    const dim = byteLength(rows[0]!.embedding) / 4;
    const matrix = new Float32Array(rows.length * dim);
    const ids: string[] = new Array(rows.length);
    let n = 0;
    for (const row of rows) {
      const vec = asFloat32(row.embedding);
      if (vec.length !== dim) continue; // a foreign-dimension row cannot be scored; skip it
      let norm = 0;
      for (let j = 0; j < dim; j++) norm += vec[j]! * vec[j]!;
      const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
      const offset = n * dim;
      for (let j = 0; j < dim; j++) matrix[offset + j] = vec[j]! * inv;
      ids[n] = row.hash_seq;
      n++;
    }
    ids.length = n;

    const position = new Map<string, number>();
    for (let i = 0; i < n; i++) position.set(ids[i]!, i);
    const lists = new Map<string, number[]>();
    for (const m of this.loader.memberships()) {
      const i = position.get(m.hash_seq);
      if (i === undefined) continue; // embedded chunk with no active document (orphan)
      let list = lists.get(m.collection);
      if (!list) {
        list = [];
        lists.set(m.collection, list);
      }
      list.push(i);
    }
    const byCollection = new Map<string, Int32Array>();
    for (const [name, list] of lists) byCollection.set(name, Int32Array.from(list));

    this.built = {
      matrix: n === rows.length ? matrix : matrix.subarray(0, n * dim),
      ids,
      dim,
      byCollection,
      dataVersion: version,
      generation: this.generation,
    };
    this.lastScores = null;
    return true;
  }

  /**
   * Cosine similarity of `embedding` against every row. Memoised on the exact
   * query array, so a hybrid query that fans one embedding across several
   * collections pays for the scan once.
   */
  private scores(embedding: ArrayLike<number>): Float32Array {
    const b = this.built!;
    const q = new Float32Array(b.dim);
    let norm = 0;
    for (let j = 0; j < b.dim; j++) {
      const v = embedding[j] ?? 0;
      q[j] = v;
      norm += v * v;
    }
    const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
    for (let j = 0; j < b.dim; j++) q[j]! *= inv;

    const last = this.lastScores;
    if (
      last &&
      last.generation === b.generation &&
      last.dataVersion === b.dataVersion &&
      sameVector(last.key, q)
    ) {
      return last.scores;
    }

    const n = b.ids.length;
    const dim = b.dim;
    const m = b.matrix;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * dim;
      let s = 0;
      for (let j = 0; j < dim; j++) s += m[o + j]! * q[j]!;
      out[i] = s;
    }
    this.lastScores = { key: q, scores: out, generation: b.generation, dataVersion: b.dataVersion };
    return out;
  }

  /**
   * Top-k nearest chunks, optionally restricted to one collection. Exact.
   * Distances are cosine distances (`1 - cos`), ascending, matching sqlite-vec.
   */
  search(embedding: ArrayLike<number>, k: number, collection?: string): VecHit[] {
    if (!this.built || k <= 0) return [];
    const scores = this.scores(embedding);
    const candidates = collection === undefined ? null : (this.built.byCollection.get(collection) ?? null);
    if (collection !== undefined && !candidates) return [];
    return this.select(scores, candidates, k);
  }

  private select(scores: Float32Array, candidates: Int32Array | null, k: number): VecHit[] {
    const b = this.built!;
    const n = candidates ? candidates.length : b.ids.length;
    const at = (a: number) => (candidates ? candidates[a]! : a);
    let chosen: number[];

    if (k >= SORT_THRESHOLD_K || k >= n) {
      chosen = new Array(n);
      for (let a = 0; a < n; a++) chosen[a] = at(a);
      chosen.sort((x, y) => scores[y]! - scores[x]!);
      chosen.length = Math.min(k, n);
    } else {
      // Bounded insertion: `best` is kept sorted descending by score.
      chosen = [];
      let floor = -Infinity;
      for (let a = 0; a < n; a++) {
        const i = at(a);
        const v = scores[i]!;
        if (chosen.length < k) {
          insertSorted(chosen, scores, i);
          if (chosen.length === k) floor = scores[chosen[k - 1]!]!;
        } else if (v > floor) {
          chosen.pop();
          insertSorted(chosen, scores, i);
          floor = scores[chosen[k - 1]!]!;
        }
      }
    }
    return chosen.map((i) => ({ hash_seq: b.ids[i]!, distance: 1 - scores[i]! }));
  }
}

function insertSorted(list: number[], scores: Float32Array, i: number): void {
  const v = scores[i]!;
  let p = list.length;
  list.push(i);
  while (p > 0 && scores[list[p - 1]!]! < v) {
    list[p] = list[p - 1]!;
    p--;
  }
  list[p] = i;
}

function sameVector(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) return false;
  return true;
}

function byteLength(v: Uint8Array | ArrayBuffer | Float32Array): number {
  return v instanceof ArrayBuffer ? v.byteLength : v.byteLength;
}

function asFloat32(v: Uint8Array | ArrayBuffer | Float32Array): Float32Array {
  if (v instanceof Float32Array) return v;
  if (v instanceof ArrayBuffer) return new Float32Array(v, 0, Math.floor(v.byteLength / 4));
  // A SQLite blob comes back as a Buffer, whose byteOffset is rarely 0 and
  // whose underlying pool is shared — copy when unaligned rather than alias.
  if (v.byteOffset % 4 === 0) return new Float32Array(v.buffer, v.byteOffset, Math.floor(v.byteLength / 4));
  return new Float32Array(v.slice().buffer, 0, Math.floor(v.byteLength / 4));
}

/** The loader `store.ts` wires up; separated so tests can build one on any db. */
export function sqliteVecIndexLoader(
  db: Database,
  wrap: <T>(op: () => T) => T = (op) => op(),
): VecIndexLoader {
  return {
    vectors: () =>
      db.prepare(`SELECT hash_seq, embedding FROM vectors_vec`).all() as VecIndexRow[],
    memberships: () =>
      wrap(() =>
        db.prepare(`
          SELECT cv.hash || '_' || cv.seq AS hash_seq, d.collection AS collection
          FROM content_vectors cv
          JOIN documents d ON d.hash = cv.hash AND d.active = 1
        `).all() as VecIndexMembership[],
      ),
    dataVersion: () => {
      const row = db.prepare(`PRAGMA data_version`).get() as { data_version: number } | undefined;
      return row?.data_version ?? 0;
    },
  };
}
