/**
 * llm-cache-retention.test.ts — re-indexing keeps llm_cache (Lloyd #1366).
 *
 * Upstream cleared llm_cache as the first step of every re-index: in the CLI's
 * `qmd update` (updateCollections), in `qmd collection add` (indexFiles) and in
 * the SDK's update(). Every cache key is content-addressed — rerank keys hash
 * (query, model, chunk text), expansion keys (query, model) — so nothing a
 * re-index changes can make an entry stale, and the wipe only meant a rerank
 * score lived until the next watcher cycle. These tests pin:
 *
 *   1. none of the three re-index paths empties or alters the cache;
 *   2. a changed document is re-scored rather than served its old score, and
 *      an unchanged one is served from the cache after a re-index;
 *   3. the explicit routes (`qmd cleanup`, clearCache()) still empty it;
 *   4. the prune-to-1,000-newest in setCachedResult still bounds the table.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { openDatabase } from "../src/db.js";
import { createStore } from "../src/index.js";
import {
  getCacheKey,
  getCachedResult,
  setCachedResult,
  clearCache,
  rerank,
} from "../src/store.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-llm-cache-retention-"));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true }).catch(() => {});
});

type Row = { hash: string; result: string; created_at: string };

function cacheRows(dbPath: string): Row[] {
  const db = openDatabase(dbPath);
  try {
    return db.prepare(`SELECT hash, result, created_at FROM llm_cache ORDER BY hash`).all() as Row[];
  } finally {
    db.close();
  }
}

function seedCache(dbPath: string, n: number): void {
  const db = openDatabase(dbPath);
  try {
    for (let i = 0; i < n; i++) {
      setCachedResult(db, getCacheKey("rerank", { query: `q${i}`, model: "m", chunk: `chunk ${i}` }), String(i / 10));
    }
  } finally {
    db.close();
  }
}

async function runQmd(args: string[], env: { dbPath: string; configDir: string; cwd: string }) {
  const argv = isBunRuntime ? [qmdScript, ...args] : [tsxCli, qmdScript, ...args];
  const proc = spawn(process.execPath, argv, {
    cwd: env.cwd,
    env: {
      ...process.env,
      INDEX_PATH: env.dbPath,
      QMD_CONFIG_DIR: env.configDir,
      PWD: env.cwd,
      QMD_DOCTOR_DEVICE_PROBE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
  proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
  return { stdout, stderr, exitCode };
}

/** A rerank double that scores every chunk by a lookup and counts its calls. */
function mockReranker(scoreOf: (text: string) => number) {
  const calls: string[][] = [];
  const llm = {
    rerankModelName: "hf:test/reranker.gguf",
    rerank: async (_q: string, docs: { file: string; text: string }[]) => {
      calls.push(docs.map(d => d.text));
      return {
        results: docs.map((d, index) => ({ file: d.file, score: scoreOf(d.text), index })),
        model: "hf:test/reranker.gguf",
      };
    },
  };
  return { llm: llm as any, calls };
}

describe("CLI re-index paths keep llm_cache", () => {
  let dbPath: string;
  let configDir: string;
  let dirA: string;
  let dirB: string;

  beforeAll(async () => {
    dbPath = join(testDir, "cli.sqlite");
    configDir = join(testDir, "cli-config");
    dirA = join(testDir, "cli-a");
    dirB = join(testDir, "cli-b");
    await mkdir(configDir, { recursive: true });
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(dirA, "one.md"), "# One\n\nFirst document.\n");
    await writeFile(join(dirA, "two.md"), "# Two\n\nSecond document.\n");
    await writeFile(join(dirB, "three.md"), "# Three\n\nThird document.\n");

    const first = await runQmd(["collection", "add", dirA, "--name", "a"], { dbPath, configDir, cwd: dirA });
    expect(first.exitCode, first.stderr).toBe(0);
    seedCache(dbPath, 5);
  });

  test("`qmd collection add` (indexFiles) leaves the rows and values unchanged", async () => {
    const before = cacheRows(dbPath);
    expect(before.length).toBe(5);
    const r = await runQmd(["collection", "add", dirB, "--name", "b"], { dbPath, configDir, cwd: dirB });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(cacheRows(dbPath)).toEqual(before);
  });

  test("`qmd update` (updateCollections) leaves the rows and values unchanged, also when a doc changed", async () => {
    const before = cacheRows(dbPath);
    expect(before.length).toBe(5);
    await writeFile(join(dirA, "two.md"), "# Two\n\nSecond document, edited.\n");
    const r = await runQmd(["update"], { dbPath, configDir, cwd: dirA });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/updated/i);
    expect(cacheRows(dbPath)).toEqual(before);
  });

  test("`qmd cleanup` is still the explicit route: it empties the cache and says how many", async () => {
    expect(cacheRows(dbPath).length).toBe(5);
    const r = await runQmd(["cleanup"], { dbPath, configDir, cwd: dirA });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("Cleared 5 cached API responses");
    expect(cacheRows(dbPath).length).toBe(0);
  });
});

describe("SDK update() keeps llm_cache, and a changed doc is re-scored", () => {
  test("a score survives an update of an unrelated doc; the changed doc does not reuse its old score", async () => {
    const dir = join(testDir, "sdk-docs");
    await mkdir(dir, { recursive: true });
    const stable = "# Stable\n\nThis document does not change.\n";
    const moving1 = "# Moving\n\nFirst version of the moving document.\n";
    const moving2 = "# Moving\n\nSecond version, rewritten.\n";
    await writeFile(join(dir, "stable.md"), stable);
    await writeFile(join(dir, "moving.md"), moving1);
    await writeFile(join(dir, "other.md"), "# Other\n\nUnrelated.\n");

    const dbPath = join(testDir, "sdk.sqlite");
    const store = await createStore({
      dbPath,
      config: { collections: { docs: { path: dir, pattern: "**/*.md" } } },
    });
    try {
      await store.update();
      const db = store.internal.db;
      const scores: Record<string, number> = { [stable]: 0.9, [moving1]: 0.2, [moving2]: 0.7 };
      const { llm, calls } = mockReranker(t => scores[t] ?? 0);
      const query = "which document is stable";

      const first = await rerank(query, [
        { file: "stable.md", text: stable },
        { file: "moving.md", text: moving1 },
      ], undefined, db, undefined, llm);
      expect(calls.length).toBe(1);
      expect(first.find(r => r.file === "stable.md")!.score).toBe(0.9);
      const before = db.prepare(`SELECT hash, result, created_at FROM llm_cache ORDER BY hash`).all();
      expect(before.length).toBe(2);

      // An unrelated doc changes, the index updates: nothing in the cache moves.
      await writeFile(join(dir, "other.md"), "# Other\n\nUnrelated, edited.\n");
      const u1 = await store.update();
      expect(u1.updated).toBe(1);
      expect(db.prepare(`SELECT hash, result, created_at FROM llm_cache ORDER BY hash`).all()).toEqual(before);

      // The scored doc changes: its new text is scored afresh, the stable one is served from cache.
      await writeFile(join(dir, "moving.md"), moving2);
      const u2 = await store.update();
      expect(u2.updated).toBe(1);
      const second = await rerank(query, [
        { file: "stable.md", text: stable },
        { file: "moving.md", text: moving2 },
      ], undefined, db, undefined, llm);
      expect(calls.length).toBe(2);
      expect(calls[1]).toEqual([moving2]);
      expect(second.find(r => r.file === "moving.md")!.score).toBe(0.7);
      expect(second.find(r => r.file === "stable.md")!.score).toBe(0.9);

      // clearCache() still empties it.
      store.internal.clearCache();
      expect((db.prepare(`SELECT COUNT(*) AS c FROM llm_cache`).get() as { c: number }).c).toBe(0);
    } finally {
      await store.close();
    }
  });
});

describe("the size bound survives without the wipe", () => {
  test("setCachedResult's prune keeps llm_cache at the 1,000 newest rows", () => {
    const dbPath = join(testDir, "prune.sqlite");
    // createStore would do; a bare table is enough for the writer under test.
    const db = openDatabase(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS llm_cache (hash TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL)`);
    // The prune fires on ~1% of writes (Math.random() < 0.01); pin it to
    // every write so the bound is deterministic.
    const realRandom = Math.random;
    Math.random = () => 0;
    try {
      for (let i = 0; i < 2000; i++) {
        setCachedResult(db, getCacheKey("rerank", { query: "q", model: "m", chunk: `c${i}` }), "0.5");
      }
    } finally {
      Math.random = realRandom;
    }
    const n = (db.prepare(`SELECT COUNT(*) AS c FROM llm_cache`).get() as { c: number }).c;
    expect(n).toBeLessThanOrEqual(1001);
    expect(n).toBeGreaterThanOrEqual(1000);
    clearCache(db);
    expect(getCachedResult(db, getCacheKey("rerank", { query: "q", model: "m", chunk: "c1999" }))).toBeNull();
    db.close();
  });
});
