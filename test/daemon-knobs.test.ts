/**
 * The knobs a long-lived daemon needs and the alias a client will reach for.
 * Each of these existed as a silent failure first: models unloading five
 * minutes after the last query, a rerank pool capped below what the card
 * could run, and `skipRerank: true` accepted on the wire and ignored.
 */
import { describe, expect, test } from "vitest";

import { DEFAULT_LLM_IDLE_TIMEOUT_MS, resolveLlmIdleTimeoutMs } from "../src/index.ts";
import { parseRerankParallelism } from "../src/llm.ts";
import { resolveRestRerank } from "../src/mcp/server.ts";

describe("QMD_LLM_IDLE_TIMEOUT_MS", () => {
  test("unset keeps the five-minute default", () => {
    expect(resolveLlmIdleTimeoutMs({})).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
    expect(DEFAULT_LLM_IDLE_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  test("0 keeps models resident", () => {
    expect(resolveLlmIdleTimeoutMs({ QMD_LLM_IDLE_TIMEOUT_MS: "0" })).toBe(0);
  });

  test("a positive value is the idle window in milliseconds", () => {
    expect(resolveLlmIdleTimeoutMs({ QMD_LLM_IDLE_TIMEOUT_MS: "30000" })).toBe(30_000);
  });

  test("garbage falls back to the default rather than disabling unload by accident", () => {
    expect(resolveLlmIdleTimeoutMs({ QMD_LLM_IDLE_TIMEOUT_MS: "never" })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
    expect(resolveLlmIdleTimeoutMs({ QMD_LLM_IDLE_TIMEOUT_MS: "-1" })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });
});

describe("QMD_RERANK_PARALLELISM", () => {
  test("unset defers to the automatic pool size", () => {
    expect(parseRerankParallelism(undefined)).toBeUndefined();
    expect(parseRerankParallelism("")).toBeUndefined();
  });

  test("a count is taken as given, above the automatic cap of 4", () => {
    expect(parseRerankParallelism("6")).toBe(6);
    expect(parseRerankParallelism("1")).toBe(1);
  });

  test("zero or garbage means automatic", () => {
    expect(parseRerankParallelism("0")).toBeUndefined();
    expect(parseRerankParallelism("many")).toBeUndefined();
  });
});

describe("REST rerank flag", () => {
  test("rerank:false disables, rerank:true enables", () => {
    expect(resolveRestRerank({ rerank: false })).toBe(false);
    expect(resolveRestRerank({ rerank: true })).toBe(true);
  });

  test("skipRerank:true is an alias for rerank:false", () => {
    expect(resolveRestRerank({ skipRerank: true })).toBe(false);
  });

  test("rerank wins when both are present", () => {
    expect(resolveRestRerank({ rerank: true, skipRerank: true })).toBe(true);
  });

  test("neither given leaves the default to the store", () => {
    expect(resolveRestRerank({})).toBeUndefined();
    expect(resolveRestRerank({ skipRerank: false })).toBeUndefined();
    expect(resolveRestRerank({ skipRerank: "yes" })).toBeUndefined();
  });
});
