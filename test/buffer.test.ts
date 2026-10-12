/**
 * The document model: every editing command a user relies on, with undo and
 * redo. A failure here means text typed, deleted, moved or replaced comes out
 * wrong, or an undo does not bring the text back.
 */
import { describe, expect, it } from "vitest";
import { cellOf, columnAt, detectIndentation, Document } from "@/buffer";

const OPTIONS = {
  autoIndent: true,
  autoClosingBrackets: true,
  typingGroupMs: 1000,
  undoSteps: 100,
};

const open = (text: string) =>
  new Document(text, { useTabs: false, size: 2 }, { ...OPTIONS }, true);

describe("typing and undo", () => {
  it("groups typing into one undo step and redoes it, so Ctrl+Z removes a typed word at once", () => {
    const document = open("hello");
    document.end(false);
    for (const character of " world") document.type(character);
    expect(document.text()).toBe("hello world");
    expect(document.undo()).toBe(true);
    expect(document.text()).toBe("hello");
    expect(document.redo()).toBe(true);
    expect(document.text()).toBe("hello world");
  });

  it("tracks unsaved changes through undo back to the saved text", () => {
    const document = open("a");
    expect(document.dirty).toBe(false);
    document.type("b");
    expect(document.dirty).toBe(true);
    document.undo();
    expect(document.dirty).toBe(false);
  });

  it("keeps CRLF line endings when saving a Windows file", () => {
    const document = open("one\r\ntwo\r\n");
    document.type("x");
    expect(document.text()).toBe("xone\r\ntwo\r\n");
  });
});

describe("auto-indent and brackets", () => {
  it("indents after an opening bracket and puts the closer on its own line", () => {
    const document = open("function f() {}");
    document.setCursor({ line: 0, column: 14 });
    document.newline();
    expect(document.lines).toEqual(["function f() {", "  ", "}"]);
    expect(document.cursor).toEqual({ line: 1, column: 2 });
  });

  it("closes a bracket, steps over the closer it typed, and deletes a pair it typed with one backspace", () => {
    const document = open("");
    document.type("(");
    expect(document.text()).toBe("()");
    document.type(")");
    expect(document.text()).toBe("()");
    expect(document.cursor.column).toBe(2);
    const fresh = open("");
    fresh.type("(");
    fresh.backspace();
    expect(fresh.text()).toBe("");
    document.setCursor({ line: 0, column: 1 });
    document.backspace();
    expect(document.text()).toBe(")");
  });

  it("surrounds a selection with a typed quote", () => {
    const document = open("word");
    document.selectAll();
    document.type('"');
    expect(document.text()).toBe('"word"');
  });
});

describe("line commands", () => {
  it("comments and uncomments the selected lines at their shared indent", () => {
    const document = open("  a\n    b");
    document.selectAll();
    document.toggleComment({ line: "//" });
    expect(document.lines).toEqual(["  // a", "  //   b"]);
    document.toggleComment({ line: "//" });
    expect(document.lines).toEqual(["  a", "    b"]);
  });

  it("moves, duplicates and deletes lines", () => {
    const document = open("1\n2\n3");
    document.setCursor({ line: 1, column: 0 });
    document.moveLines(-1);
    expect(document.lines).toEqual(["2", "1", "3"]);
    document.duplicateLines();
    expect(document.lines).toEqual(["2", "2", "1", "3"]);
    document.deleteLines();
    expect(document.lines).toEqual(["2", "1", "3"]);
  });

  it("indents and outdents a multi-line selection", () => {
    const document = open("a\nb");
    document.selectAll();
    document.indent();
    expect(document.lines).toEqual(["  a", "  b"]);
    document.outdent();
    expect(document.lines).toEqual(["a", "b"]);
  });

  it("cuts the whole line with nothing selected and pastes it above the cursor line, as VS Code", () => {
    const document = open("first\nsecond");
    const cut = document.cut();
    expect(cut).toEqual({ text: "first\n", wholeLine: true });
    expect(document.lines).toEqual(["second"]);
    document.paste(cut.text, true);
    expect(document.lines).toEqual(["first", "second"]);
  });
});

describe("find and replace", () => {
  it("finds case-insensitively by default, by whole word and by regular expression", () => {
    const document = open("Foo foo food");
    expect(
      document.find("foo", {
        caseSensitive: false,
        regex: false,
        wholeWord: false,
      }),
    ).toHaveLength(3);
    expect(
      document.find("foo", {
        caseSensitive: true,
        regex: false,
        wholeWord: false,
      }),
    ).toHaveLength(2);
    expect(
      document.find("foo", {
        caseSensitive: false,
        regex: false,
        wholeWord: true,
      }),
    ).toHaveLength(2);
    expect(
      document.find("fo+d", {
        caseSensitive: false,
        regex: true,
        wholeWord: false,
      }),
    ).toHaveLength(1);
  });

  it("replaces every match in one undo step, with group references in regular expressions", () => {
    const document = open("a1 b2\nc3");
    const options = { caseSensitive: false, regex: true, wholeWord: false };
    const matches = document.find("([a-z])(\\d)", options);
    document.replaceMatches(matches, "$2$1", /([a-z])(\d)/giu);
    expect(document.lines).toEqual(["1a 2b", "3c"]);
    document.undo();
    expect(document.lines).toEqual(["a1 b2", "c3"]);
  });

  it("matches brackets across lines", () => {
    const document = open("f(a, [b,\n c])");
    expect(document.matchingBracket({ line: 0, column: 1 })?.[1]).toEqual({
      line: 1,
      column: 3,
    });
  });
});

describe("cells and indentation", () => {
  it("maps columns to cells with tabs and wide characters, and back", () => {
    expect(cellOf("\tx", 2, 4)).toBe(5);
    expect(cellOf("日本", 1, 4)).toBe(2);
    expect(columnAt("日本", 2, 4)).toBe(1);
    expect(columnAt("ab", 10, 4)).toBe(2);
  });

  it("detects tabs and the space indent step from a file", () => {
    expect(detectIndentation(["a", "\tb", "\tc"])).toEqual({
      useTabs: true,
      size: 4,
    });
    expect(detectIndentation(["a", "    b", "        c", "    d"])).toEqual({
      useTabs: false,
      size: 4,
    });
  });
});

describe("multiple cursors", () => {
  it("adds the next occurrence and edits every one in one undo step", () => {
    const document = open("let a = a + a;");
    document.setCursor({ line: 0, column: 4 });
    document.addNextOccurrence();
    document.addNextOccurrence();
    document.addNextOccurrence();
    document.editAll("type", "bb");
    expect(document.text()).toBe("let bb = bb + bb;");
    document.editAll("backspace");
    expect(document.text()).toBe("let b = b + b;");
    document.undo();
    expect(document.text()).toBe("let bb = bb + bb;");
  });
});

describe("line transforms", () => {
  it("sorts, deduplicates, joins and changes case of the selected lines", async () => {
    const { transformLines } = await import("@/buffer");
    const document = open("b\na\nb");
    document.selectAll();
    transformLines(document, "unique");
    expect(document.lines).toEqual(["b", "a"]);
    document.selectAll();
    transformLines(document, "sortAscending");
    expect(document.lines).toEqual(["a", "b"]);
    document.setCursor({ line: 0, column: 0 });
    transformLines(document, "join");
    expect(document.lines).toEqual(["a b"]);
    document.selectAll();
    transformLines(document, "upper");
    expect(document.text()).toBe("A B");
  });
});

describe("expand selection and vertical cursors", () => {
  it("grows from the word to the brackets' inside, the brackets, the line, then shrinks back", () => {
    const document = open("call(alpha, beta);");
    document.setCursor({ line: 0, column: 6 });
    document.expandSelection();
    expect(document.selectedText()).toBe("alpha");
    document.expandSelection();
    expect(document.selectedText()).toBe("alpha, beta");
    document.expandSelection();
    expect(document.selectedText()).toBe("(alpha, beta)");
    document.shrinkSelection();
    expect(document.selectedText()).toBe("alpha, beta");
  });

  it("adds a cursor below at the same cell", () => {
    const document = open("abc\nabc");
    document.setCursor({ line: 0, column: 2 });
    document.addCursorVertical(1);
    document.editAll("type", "X");
    expect(document.lines).toEqual(["abXc", "abXc"]);
  });
});

describe("preserve case", () => {
  it("gives replacements the case of what they replace", async () => {
    const { preserveCase } = await import("@/buffer");
    expect(preserveCase("FOO", "bar")).toBe("BAR");
    expect(preserveCase("foo", "Bar")).toBe("bar");
    expect(preserveCase("Foo", "bar")).toBe("Bar");
    expect(preserveCase("fOo", "bar")).toBe("bar");
  });
});

describe("several cursors and the clipboard", () => {
  it("copies every selection line by line and pastes one line to each cursor", () => {
    const document = open("a1 b1\na2 b2");
    document.select({ line: 0, column: 0 }, { line: 0, column: 2 });
    document.extras.push({
      anchor: { line: 1, column: 0 },
      cursor: { line: 1, column: 2 },
    });
    expect(document.copyText().text).toBe("a1\na2");
    document.setCursor({ line: 0, column: 5 });
    document.extras.push({
      anchor: { line: 1, column: 5 },
      cursor: { line: 1, column: 5 },
    });
    document.editAll("type", [" x", " y"]);
    expect(document.lines).toEqual(["a1 b1 x", "a2 b2 y"]);
  });
});

describe("line openers", () => {
  it("inserts lines below and above with the indentation and deletes all left", () => {
    const document = open("  a");
    document.setCursor({ line: 0, column: 1 });
    document.insertLine(false);
    expect(document.lines).toEqual(["  a", "  "]);
    document.insertLine(true);
    expect(document.lines).toEqual(["  a", "  ", "  "]);
    document.setCursor({ line: 0, column: 3 });
    document.deleteAllLeft();
    expect(document.lines[0]).toBe("  ");
  });
});

describe("auto closing as vs code", () => {
  it("steps over only the closers it typed itself", () => {
    const document = open("");
    document.type("(");
    document.type("a");
    document.type(")");
    expect(document.text()).toBe("(a)");
    document.type(")");
    expect(document.text()).toBe("(a))");
    const other = open("f(x)");
    other.setCursor({ line: 0, column: 3 });
    other.type(")");
    expect(other.text()).toBe("f(x))");
  });
});
