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
  /**
   * The three below are optional, and together they turn a reload into a
   * refresh. `PRAGMA data_version` moves on ANY commit from another
   * connection -- a `qmd update` that found nothing to index, a rerank-cache
   * write from a second process -- and a reload reads every stored vector back
   * out of sqlite: 775 ms of blobs, 124 ms of normalising and 44 ms of
   * memberships at 37k vectors (2026-09-19), paid by whichever query arrives
   * next. With these, a version bump that changed nothing the index holds
   * costs the fingerprint (~8 ms), and one that added a document costs the
   * key scan plus a point lookup per new vector (0.06 ms each).
   */
  /** Aggregate over everything the index is built from; equal means unchanged. */
  fingerprint?(): string;
  /** Every stored key with its embed stamp. No blobs. */
  keys?(): VecIndexKey[];
  /** The embeddings for exactly these keys. */
  vectorsFor?(hashSeqs: string[]): VecIndexRow[];
}

export interface VecIndexKey {
  hash_seq: string;
  embedded_at: string;
}

interface Built {
  matrix: Float32Array; // rows L2-normalised; capacity may exceed ids.length * dim
  ids: string[];
  /** `embedded_at` per row, parallel to `ids`; "" when the loader has no keys(). */
  stamps: string[];
  position: Map<string, number>;
  dim: number;
  byCollection: Map<string, Int32Array>;
  dataVersion: number;
  generation: number;
  fingerprint: string | null;
}

/** Above this share of rows changed, a full rebuild is both simpler and no slower. */
const INCREMENTAL_MAX_CHURN = 0.25;
/** Headroom when the matrix has to grow, so a steady trickle of new chunks does not reallocate each time. */
const GROWTH_FACTOR = 1.25;

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
  /** How the index has been kept fresh; read by the daemon's /health and by tests. */
  readonly stats = { fullBuilds: 0, incrementalRefreshes: 0, unchangedSkips: 0, lastRefreshMs: 0 };

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

    const started = Date.now();
    const fingerprint = this.loader.fingerprint ? this.loader.fingerprint() : null;
    if (this.built && fingerprint !== null) {
      if (fingerprint === this.built.fingerprint) {
        // Somebody committed, and nothing this index is built from moved.
        this.built.dataVersion = version;
        this.built.generation = this.generation;
        this.stats.unchangedSkips++;
        this.stats.lastRefreshMs = Date.now() - started;
        return true;
      }
      if (this.refreshIncremental(version, fingerprint)) {
        this.stats.incrementalRefreshes++;
        this.stats.lastRefreshMs = Date.now() - started;
        return true;
      }
    }

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

    const stamps: string[] = new Array(n).fill("");
    if (this.loader.keys) {
      for (const k of this.loader.keys()) {
        const i = position.get(k.hash_seq);
        if (i !== undefined) stamps[i] = k.embedded_at;
      }
    }

    this.built = {
      matrix: n === rows.length ? matrix : matrix.subarray(0, n * dim),
      ids,
      stamps,
      position,
      dim,
      byCollection: this.partition(position),
      dataVersion: version,
      generation: this.generation,
      fingerprint,
    };
    this.lastScores = null;
    this.stats.fullBuilds++;
    this.stats.lastRefreshMs = Date.now() - started;
    return true;
  }

  private partition(position: Map<string, number>): Map<string, Int32Array> {
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
    return byCollection;
  }

  /**
   * Bring `built` up to the database without re-reading what it already holds.
   * Returns false to ask for a full rebuild; it never leaves `built` half
   * updated, because everything is staged before the first write to it.
   */
  private refreshIncremental(version: number, fingerprint: string): boolean {
    const b = this.built!;
    const loader = this.loader;
    if (!loader.keys || !loader.vectorsFor) return false;

    const keys = loader.keys();
    if (keys.length === 0) return false;
    if (keys.length > this.maxVectors) return false; // the full path records the refusal

    const live = new Set<string>();
    const wanted: string[] = [];
    const stampOf = new Map<string, string>();
    for (const k of keys) {
      live.add(k.hash_seq);
      const i = b.position.get(k.hash_seq);
      // Absent, or re-embedded under the same key (`qmd embed -f`, a model swap).
      if (i === undefined || b.stamps[i] !== k.embedded_at) {
        wanted.push(k.hash_seq);
        stampOf.set(k.hash_seq, k.embedded_at);
      }
    }
    let removed = 0;
    for (const id of b.ids) if (!live.has(id)) removed++;
    if (wanted.length + removed > INCREMENTAL_MAX_CHURN * Math.max(b.ids.length, 1)) return false;

    const fetched = new Map<string, Float32Array>();
    for (let at = 0; at < wanted.length; at += 400) {
      for (const row of loader.vectorsFor(wanted.slice(at, at + 400))) {
        const vec = asFloat32(row.embedding);
        if (vec.length !== b.dim) continue; // same rule as the full build
        fetched.set(row.hash_seq, vec);
      }
    }

    // Stage: survivors keep their rows (compacted over the removed ones), then
    // the new keys are appended. A key whose vector could not be read is left
    // out, exactly as the full build would leave it out.
    const dim = b.dim;
    const keep: number[] = [];
    for (let i = 0; i < b.ids.length; i++) if (live.has(b.ids[i]!)) keep.push(i);
    const appended = wanted.filter((id) => !b.position.has(id) && fetched.has(id));
    const n = keep.length + appended.length;

    let matrix = b.matrix;
    if (n * dim > matrix.length) {
      matrix = new Float32Array(Math.ceil(n * GROWTH_FACTOR) * dim);
      for (let a = 0; a < keep.length; a++) {
        const from = keep[a]! * dim;
        matrix.set(b.matrix.subarray(from, from + dim), a * dim);
      }
    } else if (removed > 0) {
      // In place, front to back: a row only ever moves to a lower index.
      for (let a = 0; a < keep.length; a++) {
        const from = keep[a]!;
        if (from !== a) matrix.copyWithin(a * dim, from * dim, from * dim + dim);
      }
    }

    const ids: string[] = new Array(n);
    const stamps: string[] = new Array(n);
    const position = new Map<string, number>();
    for (let a = 0; a < keep.length; a++) {
      const id = b.ids[keep[a]!]!;
      ids[a] = id;
      stamps[a] = b.stamps[keep[a]!]!;
      position.set(id, a);
    }
    const write = (row: number, vec: Float32Array) => {
      let norm = 0;
      for (let j = 0; j < dim; j++) norm += vec[j]! * vec[j]!;
      const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
      const offset = row * dim;
      for (let j = 0; j < dim; j++) matrix[offset + j] = vec[j]! * inv;
    };
    for (let a = 0; a < appended.length; a++) {
      const id = appended[a]!;
      const row = keep.length + a;
      write(row, fetched.get(id)!);
      ids[row] = id;
      stamps[row] = stampOf.get(id) ?? "";
      position.set(id, row);
    }
    for (const [id, vec] of fetched) {
      if (!b.position.has(id)) continue; // appended above
      const row = position.get(id);
      if (row === undefined) continue;
      write(row, vec);
      stamps[row] = stampOf.get(id) ?? "";
    }

    this.built = {
      matrix,
      ids,
      stamps,
      position,
      dim,
      byCollection: this.partition(position),
      dataVersion: version,
      generation: this.generation,
      fingerprint,
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
  search(embedding: ArrayLike<number>, k: number, collection?: string | readonly string[]): VecHit[] {
    if (!this.built || k <= 0) return [];
    const scores = this.scores(embedding);
    if (collection === undefined) return this.select(scores, null, k);
    if (typeof collection === "string") {
      const candidates = this.built.byCollection.get(collection) ?? null;
      return candidates ? this.select(scores, candidates, k) : [];
    }
    // Several collections, ONE ranking: the union of their rows, scored together.
    // A chunk indexed under two of them (identical content) is one candidate.
    const union = new Set<number>();
    for (const name of collection) {
      const rows = this.built.byCollection.get(name);
      if (rows) for (let a = 0; a < rows.length; a++) union.add(rows[a]!);
    }
    if (union.size === 0) return [];
    return this.select(scores, Int32Array.from(union), k);
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
    // Vectors: a new or re-embedded chunk moves count, max(rowid) or
    // max(embedded_at); a cleanup moves count. Memberships: activation moves
    // count/total(id), an edit moves max(modified_at) and the hash aggregate
    // (which also catches an edit whose mtime is older than the newest
    // document's), a collection rename moves the name list.
    fingerprint: () =>
      wrap(() => {
        const row = db.prepare(`
          SELECT
            (SELECT count(*) || ':' || ifnull(max(rowid), 0) || ':' || ifnull(max(embedded_at), '')
               FROM content_vectors)
            || '|' ||
            (SELECT count(*) || ':' || total(id) || ':' || ifnull(max(modified_at), '') || ':' ||
                    total(unicode(substr(hash, 1, 1)) * 31 + unicode(substr(hash, 2, 1))) || ':' ||
                    ifnull(group_concat(DISTINCT collection), '')
               FROM documents WHERE active = 1) AS fp
        `).get() as { fp: string } | undefined;
        return row?.fp ?? "";
      }),
    keys: () =>
      wrap(() =>
        db.prepare(`SELECT hash || '_' || seq AS hash_seq, embedded_at FROM content_vectors`).all() as VecIndexKey[],
      ),
    vectorsFor: (hashSeqs: string[]) => {
      if (hashSeqs.length === 0) return [];
      const marks = hashSeqs.map(() => "?").join(",");
      return db.prepare(`SELECT hash_seq, embedding FROM vectors_vec WHERE hash_seq IN (${marks})`).all(...hashSeqs) as VecIndexRow[];
    },
  };
}
