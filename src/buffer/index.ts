/**
 * One open file as the editor holds it: its lines, the cursor and selection,
 * every editing command VS Code has on the keyboard (typing with auto-indent
 * and auto-closing brackets, word moves and deletes, indent and outdent, line
 * comments, moving, duplicating and deleting lines, whole-line copy and paste),
 * find and replace, bracket matching, and undo and redo that group typing the
 * way VS Code does. Every change goes through one primitive that reports the
 * lines it replaced, so the highlighter only redoes what changed.
 */
import { graphemes, placeText, widthOf } from "@/text";

/** A place in the text: a line, and a UTF-16 offset in it on a grapheme boundary. */
export interface Position {
  line: number;
  column: number;
}

/** The cursor and where the selection started; no anchor means nothing is selected. */
export interface Selection {
  cursor: Position;
  anchor: Position | null;
}

/** Tabs or spaces, and how wide one indent is. */
export interface Indentation {
  useTabs: boolean;
  size: number;
}

/** One find result. */
export interface Match {
  line: number;
  start: number;
  end: number;
}

/** How a query is matched. */
export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

/** Editing preferences that apply to every document. */
export interface EditOptions {
  autoIndent: boolean;
  autoClosingBrackets: boolean;
  /** Edits of the same kind closer than this many milliseconds undo together. */
  typingGroupMs: number;
  undoSteps: number;
}

/** Lines `start` to `start + before.length` became `after`. */
interface Change {
  id: number;
  kind: string;
  time: number;
  start: number;
  before: string[];
  after: string[];
  selectionBefore: Selection;
  selectionAfter: Selection;
}

/** Receives every change: `removed` lines from `start` were replaced by `inserted` lines. */
export type ChangeListener = (
  start: number,
  removed: number,
  inserted: number,
) => void;

const OPENING = "([{";
const CLOSING = ")]}";
const PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
};
const QUOTES = "\"'`";

/** Letters, digits and underscores, in any script. */
const WORD = /[\p{L}\p{N}_$]/u;

/** @returns 0 for a word character, 1 for whitespace, 2 for anything else */
const classOf = (character: string) =>
  WORD.test(character) ? 0 : /\s/.test(character) ? 1 : 2;

/** @returns `a` before `b` */
const before = (a: Position, b: Position) =>
  a.line < b.line || (a.line === b.line && a.column < b.column);

const same = (a: Position, b: Position) =>
  a.line === b.line && a.column === b.column;

/** @returns the leading spaces and tabs of a line */
export const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];

/**
 * Finds how a file is indented, the way VS Code's `detectIndentation` does: by the lines that start with a tab
 * against those that start with spaces, and the most common step between neighbouring space indents.
 * @param lines the file's lines
 * @returns the indentation, or `null` when the file has too few indented lines to tell
 */
export const detectIndentation = (lines: string[]): Indentation | null => {
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  for (const line of lines.slice(0, 10000)) {
    if (!line.trim()) continue;
    const indent = indentOf(line);
    if (indent.startsWith("\t")) tabs++;
    else if (indent.length) spaces++;
    const width = indent.startsWith("\t") ? previous : indent.length;
    const step = Math.abs(width - previous);
    if (step >= 2 && step <= 8 && !indent.startsWith("\t"))
      steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = width;
  }
  if (tabs + spaces < 2) return null;
  if (tabs > spaces) return { useTabs: true, size: 4 };
  const [best] = [...steps.entries()].sort(
    (a, b) => b[1] - a[1] || a[0] - b[0],
  );
  return best ? { useTabs: false, size: best[0] } : null;
};

/**
 * @param text one line
 * @param column a UTF-16 offset in it
 * @param tabSize cells between tab stops
 * @returns the terminal cell the offset is drawn at
 */
export const cellOf = (text: string, column: number, tabSize: number) => {
  const placed = placeText(text.slice(0, column), tabSize);
  const last = placed.at(-1);
  return last ? last.start + last.width : 0;
};

/**
 * @param text one line
 * @param cell a terminal cell
 * @param tabSize cells between tab stops
 * @returns the offset of the grapheme drawn at that cell, or the nearer edge of a wide one; the line's length past its end
 */
export const columnAt = (text: string, cell: number, tabSize: number) => {
  let column = 0;
  for (const piece of placeText(text, tabSize)) {
    if (cell < piece.start + piece.width)
      return cell - piece.start > piece.width / 2 && piece.width > 1
        ? column + piece.source.length
        : column;
    column += piece.source.length;
  }
  return text.length;
};

/** An open file. */
export class Document {
  lines: string[];
  eol: "\n" | "\r\n";
  indentation: Indentation;
  cursor: Position = { line: 0, column: 0 };
  anchor: Position | null = null;
  /** The cell vertical moves aim for, kept across short lines. */
  private goal: number | null = null;
  private history: Change[] = [];
  private future: Change[] = [];
  private nextId = 1;
  private savedId = 0;
  /** The last change may not grow by merging: the cursor moved, the file was saved, or an undo happened. */
  private sealed = true;
  private listeners = new Set<ChangeListener>();
  /** Bumped on every change. */
  version = 0;

  /**
   * @param text the file's contents
   * @param indentation the indentation to use when the file does not tell
   * @param options editing preferences
   * @param detect read the indentation from the file
   */
  constructor(
    text: string,
    indentation: Indentation,
    public options: EditOptions,
    detect = true,
  ) {
    this.eol = text.includes("\r\n") ? "\r\n" : "\n";
    this.lines = text.split(/\r?\n/);
    this.indentation =
      (detect ? detectIndentation(this.lines) : null) ?? indentation;
  }

  /** @param listener called after every change; returns the function that stops it */
  onChange(listener: ChangeListener) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** @returns the whole text with the file's line endings */
  text() {
    return this.lines.join(this.eol);
  }

  /** @returns whether the text differs from what was last saved or loaded */
  get dirty() {
    return (this.history.at(-1)?.id ?? 0) !== this.savedId;
  }

  /** Marks the current text as saved; the next edit starts a new undo step. */
  markSaved() {
    this.savedId = this.history.at(-1)?.id ?? 0;
    this.sealed = true;
  }

  /**
   * Replaces the whole text, as when the file changed on disk; undo history is dropped.
   * @param text the new contents
   */
  reload(text: string) {
    const lines = text.split(/\r?\n/);
    this.replaceLines(0, this.lines.length, lines);
    this.history = [];
    this.future = [];
    this.savedId = 0;
    this.sealed = true;
    this.cursor = this.clamp(this.cursor);
    this.anchor = null;
  }

  private replaceLines(start: number, removed: number, inserted: string[]) {
    this.lines.splice(start, removed, ...inserted);
    this.version++;
    for (const listener of this.listeners)
      listener(start, removed, inserted.length);
  }

  /** @returns the position moved inside the text and onto a grapheme boundary */
  clamp(position: Position): Position {
    const line = Math.max(0, Math.min(position.line, this.lines.length - 1));
    const text = this.lines[line];
    let column = Math.max(0, Math.min(position.column, text.length));
    const code = text.charCodeAt(column);
    if (code >= 0xdc00 && code <= 0xdfff) column--;
    return { line, column };
  }

  get selection(): Selection {
    return {
      cursor: { ...this.cursor },
      anchor: this.anchor && { ...this.anchor },
    };
  }

  /** @returns whether anything is selected */
  get hasSelection() {
    return Boolean(this.anchor && !same(this.anchor, this.cursor));
  }

  /** @returns the selection as start and end in text order; both are the cursor when nothing is selected */
  range(): [Position, Position] {
    const anchor = this.anchor ?? this.cursor;
    return before(anchor, this.cursor)
      ? [anchor, this.cursor]
      : [this.cursor, anchor];
  }

  /** @returns the selected text, lines joined with `\n` */
  selectedText() {
    const [start, end] = this.range();
    if (start.line === end.line)
      return this.lines[start.line].slice(start.column, end.column);
    return [
      this.lines[start.line].slice(start.column),
      ...this.lines.slice(start.line + 1, end.line),
      this.lines[end.line].slice(0, end.column),
    ].join("\n");
  }

  /**
   * Moves the cursor.
   * @param position where to
   * @param select extend the selection instead of clearing it
   * @param keepGoal keep the cell vertical moves aim for
   */
  setCursor(position: Position, select = false, keepGoal = false) {
    if (select) this.anchor ??= { ...this.cursor };
    else this.anchor = null;
    this.cursor = this.clamp(position);
    if (this.anchor && same(this.anchor, this.cursor) && !select)
      this.anchor = null;
    if (!keepGoal) this.goal = null;
    this.sealed = true;
  }

  /** Selects from `anchor` to `cursor`. */
  select(anchor: Position, cursor: Position) {
    this.anchor = this.clamp(anchor);
    this.cursor = this.clamp(cursor);
    this.goal = null;
    this.sealed = true;
  }

  private previousBoundary(position: Position): Position {
    if (position.column === 0)
      return position.line
        ? {
            line: position.line - 1,
            column: this.lines[position.line - 1].length,
          }
        : position;
    const pieces = graphemes(
      this.lines[position.line].slice(0, position.column),
    );
    return {
      line: position.line,
      column: position.column - pieces.at(-1)!.length,
    };
  }

  private nextBoundary(position: Position): Position {
    const text = this.lines[position.line];
    if (position.column >= text.length)
      return position.line < this.lines.length - 1
        ? { line: position.line + 1, column: 0 }
        : position;
    const [piece] = graphemes(
      text.slice(position.column, position.column + 16),
    );
    return { line: position.line, column: position.column + piece.length };
  }

  /** @returns where a word move to the left stops: the start of the word before the cursor, as VS Code's Ctrl+← */
  private wordStart(position: Position): Position {
    if (position.column === 0) return this.previousBoundary(position);
    const text = this.lines[position.line];
    let column = position.column;
    while (column > 0 && /\s/.test(text[column - 1])) column--;
    if (column === 0) return { line: position.line, column };
    const kind = classOf(text[column - 1]);
    while (column > 0 && classOf(text[column - 1]) === kind) column--;
    return { line: position.line, column };
  }

  /** @returns where a word move to the right stops: the end of the next word, as VS Code's Ctrl+→ */
  private wordEnd(position: Position): Position {
    const text = this.lines[position.line];
    if (position.column >= text.length) return this.nextBoundary(position);
    let column = position.column;
    while (column < text.length && /\s/.test(text[column])) column++;
    if (column >= text.length) return { line: position.line, column };
    const kind = classOf(text[column]);
    while (column < text.length && classOf(text[column]) === kind) column++;
    return { line: position.line, column };
  }

  /** Cursor left by a character or a word; with a selection and no Shift it lands at the selection's start. */
  left(select: boolean, word = false) {
    if (this.hasSelection && !select) return this.setCursor(this.range()[0]);
    this.setCursor(
      word ? this.wordStart(this.cursor) : this.previousBoundary(this.cursor),
      select,
    );
  }

  /** Cursor right by a character or a word; with a selection and no Shift it lands at the selection's end. */
  right(select: boolean, word = false) {
    if (this.hasSelection && !select) return this.setCursor(this.range()[1]);
    this.setCursor(
      word ? this.wordEnd(this.cursor) : this.nextBoundary(this.cursor),
      select,
    );
  }

  /**
   * Cursor up or down, keeping the cell it started from across shorter lines.
   * @param lines how many lines; negative moves up
   * @param select extend the selection
   */
  vertical(lines: number, select: boolean) {
    const { tabSize } = { tabSize: this.indentation.size };
    this.goal ??= cellOf(
      this.lines[this.cursor.line],
      this.cursor.column,
      tabSize,
    );
    const line = this.cursor.line + lines;
    if (line < 0) return this.setCursor({ line: 0, column: 0 }, select);
    if (line >= this.lines.length)
      return this.setCursor(
        { line: this.lines.length - 1, column: this.lines.at(-1)!.length },
        select,
      );
    this.setCursor(
      { line, column: columnAt(this.lines[line], this.goal, tabSize) },
      select,
      true,
    );
  }

  /** Home: the first non-blank character, or the line's start when already there. */
  home(select: boolean) {
    const indent = indentOf(this.lines[this.cursor.line]).length;
    this.setCursor(
      {
        line: this.cursor.line,
        column: this.cursor.column === indent ? 0 : indent,
      },
      select,
    );
  }

  /** End of the line. */
  end(select: boolean) {
    this.setCursor(
      { line: this.cursor.line, column: this.lines[this.cursor.line].length },
      select,
    );
  }

  /** Start of the file. */
  top(select: boolean) {
    this.setCursor({ line: 0, column: 0 }, select);
  }

  /** End of the file. */
  bottom(select: boolean) {
    this.setCursor(
      { line: this.lines.length - 1, column: this.lines.at(-1)!.length },
      select,
    );
  }

  /** Selects the whole text. */
  selectAll() {
    this.select(
      { line: 0, column: 0 },
      { line: this.lines.length - 1, column: this.lines.at(-1)!.length },
    );
  }

  /** Selects the cursor's line with its line break; repeated, adds the next line, as VS Code's Ctrl+L. */
  selectLine() {
    const [start, end] = this.range();
    const first = this.hasSelection ? start.line : this.cursor.line;
    const last =
      this.hasSelection && end.column === 0 && end.line > start.line
        ? end.line
        : end.line + (this.hasSelection ? 1 : 0);
    const target = Math.min(
      last + (this.hasSelection ? 0 : 1),
      this.lines.length,
    );
    this.select(
      { line: first, column: 0 },
      target >= this.lines.length
        ? { line: this.lines.length - 1, column: this.lines.at(-1)!.length }
        : { line: target, column: 0 },
    );
  }

  /**
   * @param position a place in the text
   * @returns the word around it (letters, digits, `_`, `$`), or `null` when it is not on one
   */
  wordAt(position: Position): [Position, Position] | null {
    const text = this.lines[position.line];
    let start = position.column;
    let end = position.column;
    if (!WORD.test(text[start] ?? "") && !WORD.test(text[start - 1] ?? ""))
      return null;
    while (start > 0 && WORD.test(text[start - 1])) start--;
    while (end < text.length && WORD.test(text[end])) end++;
    return [
      { line: position.line, column: start },
      { line: position.line, column: end },
    ];
  }

  /** Selects the word at a position, or the run of other characters there, as a double-click does. */
  selectWordAt(position: Position) {
    const word = this.wordAt(position);
    if (word) return this.select(word[0], word[1]);
    const text = this.lines[position.line];
    const kind = classOf(text[position.column] ?? " ");
    let start = position.column;
    let end = position.column;
    while (start > 0 && classOf(text[start - 1]) === kind) start--;
    while (end < text.length && classOf(text[end]) === kind) end++;
    this.select(
      { line: position.line, column: start },
      { line: position.line, column: end },
    );
  }

  /**
   * Replaces a range with text: the one way every edit changes the document.
   * @param from start of the range
   * @param to end of the range
   * @param text what to put there; `\n` breaks lines
   * @param kind edits of the same kind in a row undo together (`type`, `delete`); any other kind is its own step
   * @returns the position just after the inserted text
   */
  replace(from: Position, to: Position, text: string, kind = "edit"): Position {
    if (before(to, from)) [from, to] = [to, from];
    const selectionBefore = this.selection;
    const prefix = this.lines[from.line].slice(0, from.column);
    const suffix = this.lines[to.line].slice(to.column);
    const beforeLines = this.lines.slice(from.line, to.line + 1);
    const afterLines = (prefix + text + suffix).split("\n");
    this.replaceLines(from.line, beforeLines.length, afterLines);
    const end = {
      line: from.line + afterLines.length - 1,
      column: afterLines.at(-1)!.length - suffix.length,
    };
    this.cursor = end;
    this.anchor = null;
    this.goal = null;
    this.record({
      kind,
      start: from.line,
      before: beforeLines,
      after: afterLines,
      selectionBefore,
      selectionAfter: this.selection,
    });
    return end;
  }

  /** Replaces whole lines in one undo step, keeping the given selection. */
  private replaceBlock(
    start: number,
    count: number,
    after: string[],
    selection: Selection,
    kind = "edit",
  ) {
    const selectionBefore = this.selection;
    const beforeLines = this.lines.slice(start, start + count);
    this.replaceLines(start, count, after);
    this.cursor = this.clamp(selection.cursor);
    this.anchor = selection.anchor && this.clamp(selection.anchor);
    this.goal = null;
    this.record({
      kind,
      start,
      before: beforeLines,
      after,
      selectionBefore,
      selectionAfter: this.selection,
    });
  }

  private record(change: Omit<Change, "id" | "time">) {
    const now = Date.now();
    const last = this.history.at(-1);
    this.future = [];
    const groups = change.kind === "type" || change.kind === "delete";
    if (
      last &&
      !this.sealed &&
      groups &&
      last.kind === change.kind &&
      now - last.time < this.options.typingGroupMs &&
      change.start >= last.start &&
      change.start + change.before.length <= last.start + last.after.length
    ) {
      const offset = change.start - last.start;
      last.after = [
        ...last.after.slice(0, offset),
        ...change.after,
        ...last.after.slice(offset + change.before.length),
      ];
      last.selectionAfter = change.selectionAfter;
      last.time = now;
    } else {
      this.history.push({ ...change, id: this.nextId++, time: now });
      if (this.history.length > this.options.undoSteps) this.history.shift();
    }
    this.sealed = !groups;
  }

  /** @returns whether there was something to undo */
  undo() {
    const change = this.history.pop();
    if (!change) return false;
    this.replaceLines(change.start, change.after.length, change.before);
    this.future.push(change);
    this.restore(change.selectionBefore);
    return true;
  }

  /** @returns whether there was something to redo */
  redo() {
    const change = this.future.pop();
    if (!change) return false;
    this.replaceLines(change.start, change.before.length, change.after);
    this.history.push(change);
    this.restore(change.selectionAfter);
    return true;
  }

  private restore(selection: Selection) {
    this.cursor = this.clamp(selection.cursor);
    this.anchor = selection.anchor && this.clamp(selection.anchor);
    this.goal = null;
    this.sealed = true;
  }

  /** @returns one indent: a tab, or spaces to the next indent stop from `cell` */
  private indentUnit(cell = 0) {
    return this.indentation.useTabs
      ? "\t"
      : " ".repeat(this.indentation.size - (cell % this.indentation.size));
  }

  /**
   * Types text at the cursor, replacing the selection. A bracket or quote typed over a selection surrounds it; an
   * opening bracket typed before blank space or a closer gets its closer; a closer typed in front of the same closer
   * steps over it.
   * @param text what was typed
   */
  type(text: string) {
    const [start, end] = this.range();
    const line = this.lines[this.cursor.line];
    const next = line[this.cursor.column] ?? "";
    const previous = line[this.cursor.column - 1] ?? "";
    if (this.options.autoClosingBrackets && text.length === 1) {
      if (this.hasSelection && PAIRS[text]) {
        const inner = this.selectedText();
        this.replace(start, end, text + inner + PAIRS[text], "edit");
        const innerEnd =
          start.line === end.line
            ? { line: start.line, column: end.column + 1 }
            : { line: end.line, column: end.column };
        return this.select(
          { line: start.line, column: start.column + 1 },
          innerEnd,
        );
      }
      if (
        !this.hasSelection &&
        (CLOSING.includes(text) || QUOTES.includes(text)) &&
        next === text
      )
        return this.setCursor({
          ...this.cursor,
          column: this.cursor.column + 1,
        });
      const closes =
        !next ||
        /\s/.test(next) ||
        CLOSING.includes(next) ||
        next === ";" ||
        next === ",";
      if (
        !this.hasSelection &&
        closes &&
        (OPENING.includes(text) ||
          (QUOTES.includes(text) && !WORD.test(previous) && previous !== text))
      ) {
        this.replace(start, end, text + PAIRS[text], "type");
        return this.setCursor({
          ...this.cursor,
          column: this.cursor.column - 1,
        });
      }
    }
    this.replace(start, end, text, "type");
  }

  /** Inserts a line break, carrying the indentation over and adding one after an opening bracket. */
  newline() {
    const [start, end] = this.range();
    const line = this.lines[start.line];
    if (!this.options.autoIndent) return this.replace(start, end, "\n", "edit");
    const indent = indentOf(line).slice(0, start.column);
    const previous = line.slice(0, start.column).trimEnd().at(-1) ?? "";
    const next = this.lines[end.line][end.column] ?? "";
    if (OPENING.includes(previous)) {
      const inner =
        indent +
        this.indentUnit(cellOf(indent, indent.length, this.indentation.size));
      if (next === PAIRS[previous]) {
        this.replace(start, end, `\n${inner}\n${indent}`, "edit");
        return this.setCursor({ line: start.line + 1, column: inner.length });
      }
      return this.replace(start, end, `\n${inner}`, "edit");
    }
    this.replace(start, end, `\n${indent}`, "edit");
  }

  /**
   * Deletes backwards: the selection, a word, an indent step in leading blanks, an empty bracket pair, or one grapheme.
   * @param word delete to the start of the word, as Ctrl+Backspace
   */
  backspace(word = false) {
    if (this.hasSelection)
      return void this.replace(...this.range(), "", "delete");
    const { line, column } = this.cursor;
    const text = this.lines[line];
    if (word)
      return void this.replace(
        this.wordStart(this.cursor),
        this.cursor,
        "",
        "delete",
      );
    const leading = text.slice(0, column);
    if (column && !this.indentation.useTabs && /^ +$/.test(leading)) {
      const stop =
        Math.floor((column - 1) / this.indentation.size) *
        this.indentation.size;
      return void this.replace(
        { line, column: stop },
        this.cursor,
        "",
        "delete",
      );
    }
    if (
      this.options.autoClosingBrackets &&
      column &&
      PAIRS[text[column - 1]] === text[column] &&
      text[column]
    ) {
      return void this.replace(
        { line, column: column - 1 },
        { line, column: column + 1 },
        "",
        "delete",
      );
    }
    this.replace(this.previousBoundary(this.cursor), this.cursor, "", "delete");
  }

  /**
   * Deletes forwards: the selection, to the end of a word, or one grapheme (joining the next line at the end).
   * @param word delete to the end of the word, as Ctrl+Delete
   */
  deleteForward(word = false) {
    if (this.hasSelection)
      return void this.replace(...this.range(), "", "delete");
    this.replace(
      this.cursor,
      word ? this.wordEnd(this.cursor) : this.nextBoundary(this.cursor),
      "",
      "delete",
    );
  }

  /** @returns the lines a line command acts on: the selection's, without a last line the selection only touches at its start */
  private selectedLines(): [number, number] {
    const [start, end] = this.range();
    return [
      start.line,
      end.line > start.line && end.column === 0 ? end.line - 1 : end.line,
    ];
  }

  /** Tab: indents the selected lines, or inserts one indent at the cursor. */
  indent() {
    const [start, end] = this.range();
    if (
      !this.hasSelection ||
      (start.line === end.line &&
        !(
          start.column === 0 &&
          end.column === this.lines[end.line].length &&
          end.column > 0
        ))
    ) {
      if (this.hasSelection)
        return this.replace(start, end, this.indentUnit(), "type");
      return this.type(
        this.indentUnit(
          cellOf(
            this.lines[this.cursor.line],
            this.cursor.column,
            this.indentation.size,
          ),
        ),
      );
    }
    const [first, last] = this.selectedLines();
    const unit = this.indentUnit();
    const after = this.lines
      .slice(first, last + 1)
      .map((line) => (line ? unit + line : line));
    const shift = (position: Position) =>
      position.line >= first &&
      position.line <= last &&
      this.lines[position.line]
        ? { line: position.line, column: position.column + unit.length }
        : position;
    this.replaceBlock(first, after.length, after, {
      cursor: shift(this.cursor),
      anchor: this.anchor && shift(this.anchor),
    });
  }

  /** Shift+Tab: removes one indent from the selected lines, or the cursor's line. */
  outdent() {
    const [first, last] = this.selectedLines();
    const removed: number[] = [];
    const after = this.lines.slice(first, last + 1).map((line) => {
      const take = line.startsWith("\t")
        ? 1
        : Math.min(
            indentOf(line).replace(/\t.*/, "").length,
            this.indentation.size,
          );
      removed.push(take);
      return line.slice(take);
    });
    if (!removed.some(Boolean)) return;
    const shift = (position: Position) =>
      position.line >= first && position.line <= last
        ? {
            line: position.line,
            column: Math.max(
              0,
              position.column - removed[position.line - first],
            ),
          }
        : position;
    this.replaceBlock(first, after.length, after, {
      cursor: shift(this.cursor),
      anchor: this.anchor && shift(this.anchor),
    });
  }

  /**
   * Comments the selected lines out, or back in when every non-blank one already is.
   * @param comment the language's line marker, or its block pair for languages without one
   */
  toggleComment(comment: { line: string } | { block: [string, string] }) {
    const [first, last] = this.selectedLines();
    const lines = this.lines.slice(first, last + 1);
    const filled = lines.filter((line) => line.trim());
    if (!filled.length) return;
    const [open, close] =
      "line" in comment ? [comment.line, ""] : comment.block;
    const commented = (line: string) =>
      line.trimStart().startsWith(open) &&
      (!close || line.trimEnd().endsWith(close));
    const shared = Math.min(...filled.map((line) => indentOf(line).length));
    const remove = filled.every(commented);
    const after = lines.map((line) => {
      if (!line.trim()) return line;
      if (remove) {
        const indent = indentOf(line);
        let body = line.slice(indent.length + open.length);
        if (body.startsWith(" ")) body = body.slice(1);
        if (close)
          body = body.trimEnd().slice(0, -close.length).replace(/ $/, "");
        return indent + body;
      }
      return `${line.slice(0, shared)}${open} ${line.slice(shared)}${close ? ` ${close}` : ""}`;
    });
    const shift = (position: Position) => {
      if (position.line < first || position.line > last) return position;
      const index = position.line - first;
      return {
        line: position.line,
        column: Math.max(
          0,
          Math.min(
            after[index].length,
            position.column + after[index].length - lines[index].length,
          ),
        ),
      };
    };
    this.replaceBlock(first, lines.length, after, {
      cursor: shift(this.cursor),
      anchor: this.anchor && shift(this.anchor),
    });
  }

  /** Deletes the selected lines, or the cursor's line. */
  deleteLines() {
    const [first, last] = this.selectedLines();
    if (this.lines.length === last - first + 1)
      return this.replaceBlock(0, this.lines.length, [""], {
        cursor: { line: 0, column: 0 },
        anchor: null,
      });
    const column = this.cursor.column;
    this.replaceBlock(first, last - first + 1, [], {
      cursor: {
        line: Math.min(first, this.lines.length - 1 - (last - first + 1)),
        column,
      },
      anchor: null,
    });
  }

  /** Copies the selected lines, or the cursor's line, below themselves, as VS Code's Shift+Alt+↓. */
  duplicateLines() {
    const [first, last] = this.selectedLines();
    const copy = this.lines.slice(first, last + 1);
    const count = copy.length;
    const move = (position: Position) => ({
      line: position.line + count,
      column: position.column,
    });
    this.replaceBlock(last + 1, 0, copy, {
      cursor: move(this.cursor),
      anchor: this.anchor && move(this.anchor),
    });
  }

  /**
   * Moves the selected lines, or the cursor's line, one line up or down, as VS Code's Alt+↑ and Alt+↓.
   * @param direction -1 up, 1 down
   */
  moveLines(direction: -1 | 1) {
    const [first, last] = this.selectedLines();
    if (direction < 0 ? first === 0 : last === this.lines.length - 1) return;
    const block = this.lines.slice(first, last + 1);
    const start = direction < 0 ? first - 1 : first;
    const after =
      direction < 0
        ? [...block, this.lines[first - 1]]
        : [this.lines[last + 1], ...block];
    const move = (position: Position) => ({
      line: position.line + direction,
      column: position.column,
    });
    this.replaceBlock(
      start,
      after.length,
      after,
      { cursor: move(this.cursor), anchor: this.anchor && move(this.anchor) },
      "move",
    );
  }

  /**
   * Text for the clipboard: the selection, or the whole line with its break when nothing is selected, as VS Code copies.
   * @returns the text and whether it is a whole line
   */
  copyText(): { text: string; wholeLine: boolean } {
    if (this.hasSelection)
      return { text: this.selectedText(), wholeLine: false };
    return { text: `${this.lines[this.cursor.line]}\n`, wholeLine: true };
  }

  /** Cuts the selection, or the cursor's whole line. @returns what was cut, as `copyText` describes it */
  cut() {
    const copied = this.copyText();
    if (copied.wholeLine) this.deleteLines();
    else this.replace(...this.range(), "", "delete");
    return copied;
  }

  /**
   * Pastes text; a whole line copied without a selection goes in above the cursor's line, as in VS Code.
   * @param text the clipboard text
   * @param wholeLine it was copied as a whole line
   */
  paste(text: string, wholeLine = false) {
    const normalized = text.replace(/\r\n?/g, "\n");
    if (wholeLine && !this.hasSelection) {
      const { line, column } = this.cursor;
      const inserted = normalized.replace(/\n$/, "").split("\n");
      return this.replaceBlock(line, 0, inserted, {
        cursor: { line: line + inserted.length, column },
        anchor: null,
      });
    }
    this.replace(...this.range(), normalized, "edit");
  }

  /**
   * Finds every match of a query.
   * @param query what to look for; a regular expression when `options.regex`
   * @param options case, regular expression and whole-word matching
   * @param limit the most matches returned
   * @returns the matches in text order; none for an empty query or an invalid expression
   */
  find(query: string, options: FindOptions, limit = 20000): Match[] {
    if (!query) return [];
    let pattern: RegExp;
    try {
      const source = options.regex
        ? query
        : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(
        options.wholeWord
          ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
          : source,
        `gu${options.caseSensitive ? "" : "i"}`,
      );
    } catch {
      return [];
    }
    const matches: Match[] = [];
    for (
      let line = 0;
      line < this.lines.length && matches.length < limit;
      line++
    ) {
      pattern.lastIndex = 0;
      for (const match of this.lines[line].matchAll(pattern)) {
        if (!match[0].length) continue;
        matches.push({
          line,
          start: match.index,
          end: match.index + match[0].length,
        });
        if (matches.length >= limit) break;
      }
    }
    return matches;
  }

  /**
   * Replaces matches in one undo step.
   * @param matches what `find` returned for the current text
   * @param replacement the new text; with `pattern`, `$1` and `$&` refer to the match's groups
   * @param pattern the expression the matches came from, for group references
   * @returns how many were replaced
   */
  replaceMatches(matches: Match[], replacement: string, pattern?: RegExp) {
    if (!matches.length) return 0;
    const first = matches[0].line;
    const last = matches.at(-1)!.line;
    const after = this.lines.slice(first, last + 1);
    for (const match of [...matches].reverse()) {
      const text = after[match.line - first];
      const found = text.slice(match.start, match.end);
      const value = pattern
        ? found.replace(
            new RegExp(pattern.source, pattern.flags.replace("g", "")),
            replacement,
          )
        : replacement;
      after[match.line - first] =
        text.slice(0, match.start) + value + text.slice(match.end);
    }
    const joined = after.join("\n").split("\n");
    const firstMatch = matches[0];
    this.replaceBlock(first, last - first + 1, joined, {
      cursor: { line: firstMatch.line, column: firstMatch.start },
      anchor: null,
    });
    return matches.length;
  }

  /**
   * Finds the bracket matching the one at or just before a position, skipping brackets inside quotes on each line.
   * @param position where to look
   * @param maxLines how far to search
   * @returns the bracket's own position and its partner's, or `null`
   */
  matchingBracket(
    position: Position,
    maxLines = 5000,
  ): [Position, Position] | null {
    const text = this.lines[position.line];
    const at = [position.column, position.column - 1].find(
      (column) =>
        column >= 0 && (OPENING + CLOSING).includes(text[column] ?? "x"),
    );
    if (at === undefined) return null;
    const bracket = text[at];
    const forward = OPENING.includes(bracket);
    const partner = forward
      ? CLOSING[OPENING.indexOf(bracket)]
      : OPENING[CLOSING.indexOf(bracket)];
    let depth = 0;
    for (
      let line = position.line, steps = 0;
      line >= 0 && line < this.lines.length && steps < maxLines;
      line += forward ? 1 : -1, steps++
    ) {
      const body = this.lines[line];
      const columns = [...body].map((_character, index) => index);
      const order = forward ? columns : columns.reverse();
      for (const column of order) {
        if (line === position.line && (forward ? column < at : column > at))
          continue;
        if (body[column] === bracket) depth++;
        else if (body[column] === partner && --depth === 0)
          return [
            { line: position.line, column: at },
            { line, column },
          ];
      }
    }
    return null;
  }

  /** Moves the cursor to the matching bracket, as neovim's `%` and VS Code's Ctrl+Shift+\. */
  jumpToBracket() {
    const match = this.matchingBracket(this.cursor);
    if (match) this.setCursor(match[1]);
  }

  /**
   * Prepares the text for saving.
   * @param trimTrailingWhitespace remove blanks at line ends
   * @param insertFinalNewline make the file end with a line break
   */
  beforeSave(trimTrailingWhitespace: boolean, insertFinalNewline: boolean) {
    if (trimTrailingWhitespace) {
      const trimmed = this.lines.map((line) => line.replace(/[ \t]+$/, ""));
      if (trimmed.some((line, index) => line !== this.lines[index]))
        this.replaceBlock(0, this.lines.length, trimmed, this.selection);
    }
    if (insertFinalNewline && this.lines.at(-1) !== "")
      this.replaceBlock(this.lines.length, 0, [""], this.selection);
  }
}

/** @returns the display width of a line in cells */
export const lineWidth = (text: string, tabSize: number) =>
  text.includes("\t") ? cellOf(text, text.length, tabSize) : widthOf(text);
