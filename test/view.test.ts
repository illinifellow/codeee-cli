/**
 * How code is laid out on screen and moved through: folding, word wrap,
 * several cursors moving together, symbols and sticky scroll. A failure means
 * lines vanish or repeat, cursors drift apart, or navigation lands elsewhere.
 */
import { describe, expect, it } from "vitest";
import { Document } from "@/buffer";
import { foldEnd, foldsHiding, visibleLines } from "@/folding";
import { fileSymbols, stickyLines } from "@/symbols";
import { wrapSegments } from "@/ui/editor";

const OPTIONS = {
  autoIndent: true,
  autoClosingBrackets: true,
  typingGroupMs: 1000,
  undoSteps: 100,
};
const CODE = [
  "function a() {",
  "  if (x) {",
  "    y();",
  "  }",
  "}",
  "const b = () => 1;",
];

describe("folding", () => {
  it("folds a block down to its closing line and hides only what it covers", () => {
    expect(foldEnd(CODE, 0)).toBe(3);
    expect(foldEnd(CODE, 1)).toBe(2);
    expect(foldEnd(CODE, 5)).toBeNull();
    expect(visibleLines(CODE, new Set([0]))).toEqual([0, 4, 5]);
    expect(foldsHiding(CODE, new Set([0]), 2)).toEqual([0]);
  });
});

describe("word wrap", () => {
  it("breaks at spaces within the width and keeps every cell", () => {
    const segments = wrapSegments("alpha beta gamma delta", 11, 2);
    expect(segments).toEqual([
      [0, 11],
      [11, 22],
    ]);
    expect(wrapSegments("", 10, 2)).toEqual([[0, 0]]);
  });
});

describe("several cursors", () => {
  it("move together and merge when they meet", () => {
    const document = new Document(
      "ab\nab",
      { useTabs: false, size: 2 },
      { ...OPTIONS },
    );
    document.setCursor({ line: 0, column: 1 });
    document.extras.push({
      anchor: { line: 1, column: 1 },
      cursor: { line: 1, column: 1 },
    });
    document.moveAll((one) => one.end(false));
    expect([
      document.cursor,
      ...document.extras.map((extra) => extra.cursor),
    ]).toEqual([
      { line: 0, column: 2 },
      { line: 1, column: 2 },
    ]);
    document.moveAll((one) => one.top(false));
    expect(document.extras).toEqual([]);
  });
});

describe("symbols", () => {
  it("finds declarations and the blocks sticky scroll pins", () => {
    expect(
      fileSymbols(CODE, "typescript").map((symbol) => symbol.name),
    ).toEqual(["a", "b"]);
    expect(stickyLines(CODE, 2, 5)).toEqual([0, 1]);
    expect(
      fileSymbols(["# Title", "text", "## Part"], "markdown").map(
        (symbol) => symbol.kind,
      ),
    ).toEqual(["h1", "h2"]);
  });
});
