/**
 * A rerank that could not run must say so, and must not be remembered as one.
 *
 * When no ranking context can be created (in practice: the GPU has no VRAM for
 * one) the LLM layer answers every document with the constant 0.5 and
 * `model: "fallback"`. Until 2026-09-19 that reached the caller as an ordinary
 * result list over HTTP 200, and `rerank()` wrote each 0.5 into the score cache
 * — so a few seconds of VRAM pressure pinned those (query, chunk) pairs at "no
 * opinion" for as long as the cache lived, answered as if ranked.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore, rerank, type Store } from "../src/store.ts";
import type { LlamaCpp, RerankResult } from "../src/llm.ts";

function fakeLlm(answer: (docs: { file: string; text: string }[]) => RerankResult) {
  const calls: number[] = [];
  const llm = {
    rerankModelName: "fake-reranker",
    rerank: async (_q: string, docs: { file: string; text: string }[]) => (calls.push(docs.length), answer(docs)),
  } as unknown as LlamaCpp;
  return { llm, calls };
}

const docs = [
  { file: "a.md", text: "alpha chunk" },
  { file: "b.md", text: "beta chunk" },
];
const ranked = (d: typeof docs): RerankResult => ({
  model: "fake-reranker",
  results: d.map((x, i) => ({ ...x, score: 0.9 - i * 0.4, index: i })),
});
const fallback = (d: typeof docs): RerankResult => ({
  model: "fallback",
  reason: "A context size of 4096 is too large for the available VRAM",
  results: d.map((x) => ({ ...x, score: 0.5, index: 0 })),
});

describe("rerank fallback", () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-rerank-fallback-"));
    store = createStore(join(dir, "index.sqlite"));
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("reports the fallback and its reason to the caller", async () => {
    const { llm } = fakeLlm(fallback);
    const reasons: string[] = [];
    const out = await rerank("q", docs, "m", store.db, undefined, llm, (r) => reasons.push(r));
    expect(reasons).toEqual(["A context size of 4096 is too large for the available VRAM"]);
    expect(out.map((r) => r.score)).toEqual([0.5, 0.5]);
  });

  test("does not cache a fallback: the next request is ranked for real", async () => {
    const down = fakeLlm(fallback);
    await rerank("q", docs, "m", store.db, undefined, down.llm);

    const up = fakeLlm(ranked);
    const reasons: string[] = [];
    const out = await rerank("q", docs, "m", store.db, undefined, up.llm, (r) => reasons.push(r));
    expect(up.calls).toEqual([2]); // both documents reached the model; nothing came from a cache
    expect(reasons).toEqual([]);
    expect(out.map((r) => [r.file, r.score])).toEqual([["a.md", 0.9], ["b.md", 0.5]]);
  });

  test("a real ranking is still cached, and says nothing", async () => {
    const first = fakeLlm(ranked);
    await rerank("q", docs, "m", store.db, undefined, first.llm);
    const second = fakeLlm(ranked);
    const reasons: string[] = [];
    await rerank("q", docs, "m", store.db, undefined, second.llm, (r) => reasons.push(r));
    expect(second.calls).toEqual([]);
    expect(reasons).toEqual([]);
  });
});
