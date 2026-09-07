/**
 * A single character is matched as a token, not expanded as a prefix.
 * `a*` is every token that starts with "a"; on an 11.7k-document index FTS5
 * walked and BM25-ranked that entire posting list — 759 ms for a query that
 * took 12 ms without the stray letter (2026-09-07).
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore, type Store } from "../src/store.ts";

let dir: string;
let store: Store;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "qmd-fts-"));
  store = createStore(join(dir, "fts.sqlite"));
  const now = new Date().toISOString();
  const docs: [string, string][] = [
    ["apple", "An apple a day. Apples are fruit."],
    ["c-lang", "Programs in c use pointers. The c compiler."],
    ["cat", "The cat sat. Cats and category theory."],
  ];
  for (const [name, body] of docs) {
    const hash = `h-${name}`;
    store.insertContent(hash, body, now);
    store.insertDocument("notes", `${name}.md`, name, hash, now, now);
  }
});

afterAll(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("single-character FTS terms", () => {
  test("a two-letter term still prefix-matches", () => {
    const hits = store.searchFTS("ca", 10, "notes").map((r) => r.displayPath);
    expect(hits).toContain("notes/cat.md");
  });

  test("a one-letter term matches only itself as a token", () => {
    // "c" is a whole token in c-lang.md. It is also a prefix of "cat", "cats",
    // "category" and "compiler", none of which may match any more.
    const hits = store.searchFTS("c", 10, "notes").map((r) => r.displayPath);
    expect(hits).toEqual(["notes/c-lang.md"]);
  });

  test("a one-letter term inside a longer query leaves the other terms' prefix matching alone", () => {
    const hits = store.searchFTS("apple a", 10, "notes").map((r) => r.displayPath);
    expect(hits).toEqual(["notes/apple.md"]);
  });
});
