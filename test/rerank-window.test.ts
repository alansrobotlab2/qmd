import { afterEach, describe, expect, test } from "vitest";

import { rerankWindow, resolveRerankWindowChars } from "../src/store.ts";

const filler = (n: number, ch = "x") => Array.from({ length: n }, (_, i) => `${ch}${i % 10}`).join(" ");

describe("rerankWindow", () => {
  test("0 means the whole chunk, and short chunks are untouched", () => {
    const text = "short chunk";
    expect(rerankWindow(text, ["chunk"], 0)).toBe(text);
    expect(rerankWindow(text, ["chunk"], 600)).toBe(text);
  });

  test("opens a third of the way before the first query term", () => {
    const text = `${filler(400)} the guardian rolled back ${filler(400)}`;
    const win = rerankWindow(text, ["guardian"], 300);
    expect(win.length).toBe(300);
    const at = win.indexOf("guardian");
    expect(at).toBeGreaterThan(60);
    expect(at).toBeLessThan(140);
  });

  test("falls back to the head when no term appears", () => {
    const text = filler(600);
    expect(rerankWindow(text, ["absent"], 200)).toBe(text.slice(0, 200));
  });

  test("clamps at the end so the window is always full-width", () => {
    const text = `${filler(400)} guardian`;
    const win = rerankWindow(text, ["guardian"], 200);
    expect(win.length).toBe(200);
    expect(win.endsWith("guardian")).toBe(true);
  });

  test("does not open mid-token", () => {
    const text = `${filler(300, "word")} guardian ${filler(300)}`;
    const win = rerankWindow(text, ["guardian"], 250);
    expect(win.startsWith(" ")).toBe(false);
    // the window starts on a word boundary: the char before it in `text` is a space
    const start = text.indexOf(win);
    expect(text[start - 1]).toBe(" ");
  });

  test("terms are matched case-insensitively", () => {
    const text = `${filler(400)} GUARDIAN ${filler(400)}`;
    expect(rerankWindow(text, ["guardian"], 200)).toContain("GUARDIAN");
  });
});

describe("resolveRerankWindowChars", () => {
  afterEach(() => {
    delete process.env.QMD_RERANK_WINDOW_CHARS;
  });

  test("an explicit option wins over the environment", () => {
    expect(resolveRerankWindowChars(300, { QMD_RERANK_WINDOW_CHARS: "900" })).toBe(300);
    expect(resolveRerankWindowChars(0, { QMD_RERANK_WINDOW_CHARS: "900" })).toBe(0);
  });

  test("the environment supplies the default; unset means whole chunks", () => {
    expect(resolveRerankWindowChars(undefined, {})).toBe(0);
    expect(resolveRerankWindowChars(undefined, { QMD_RERANK_WINDOW_CHARS: "600" })).toBe(600);
  });

  test("garbage in the environment is a warning, not a crash, and means whole chunks", () => {
    expect(resolveRerankWindowChars(undefined, { QMD_RERANK_WINDOW_CHARS: "lots" })).toBe(0);
    expect(resolveRerankWindowChars(undefined, { QMD_RERANK_WINDOW_CHARS: "-5" })).toBe(0);
  });
});
