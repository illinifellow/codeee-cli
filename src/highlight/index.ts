/**
 * Syntax highlighting of open files with shiki, in the editor's theme. A
 * file is tokenized from the top in chunks of lines, each chunk starting from
 * the grammar state the previous one ended in, and only as far as the screen
 * needs. An edit drops the tokens from the changed line on and keeps the rest,
 * so typing re-highlights a chunk, not the file; work yields to input between
 * chunks and stops when the text changes under it.
 */
import {
  createHighlighterCore,
  type GrammarState,
  type HighlighterCore,
  type ThemeRegistrationAny,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import type { Document } from "@/buffer";

/** A coloured piece of a line. */
export interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const THEME_NAME = "codeee-editor";

/** One highlighter per theme, shared by every open file. */
export class SyntaxHighlighter {
  private core: Promise<HighlighterCore>;
  /** The theme's default text colour. */
  foreground: string | undefined;

  /** @param theme a VS Code theme JSON */
  constructor(theme: Promise<ThemeRegistrationAny>) {
    this.core = theme.then((registration) => {
      const colors = (registration as { colors?: Record<string, string> })
        .colors;
      this.foreground = colors?.["editor.foreground"];
      return createHighlighterCore({
        themes: [{ ...registration, name: THEME_NAME }],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    });
  }

  /**
   * @param language a shiki language id
   * @returns the highlighter with that grammar loaded, or `null` when shiki has no grammar for it
   */
  async ready(language: string) {
    if (!(language in bundledLanguages)) return null;
    const core = await this.core;
    if (!core.getLoadedLanguages().includes(language))
      await core.loadLanguage(
        bundledLanguages[language as keyof typeof bundledLanguages],
      );
    return core;
  }

  /**
   * Tokenizes a run of lines.
   * @returns the coloured lines and the grammar state after the last one
   */
  tokenize(
    core: HighlighterCore,
    language: string,
    lines: string[],
    state: GrammarState | undefined,
  ) {
    const tokens = core.codeToTokensBase(lines.join("\n"), {
      lang: language,
      theme: THEME_NAME,
      grammarState: state,
    });
    const next = core.getLastGrammarState(tokens);
    const segments = tokens.map((line) =>
      line.map((token) => {
        const segment: Segment = { text: token.content, color: token.color };
        if (token.fontStyle && token.fontStyle & 1) segment.italic = true;
        if (token.fontStyle && token.fontStyle & 2) segment.bold = true;
        if (token.fontStyle && token.fontStyle & 4) segment.underline = true;
        return segment;
      }),
    );
    return { segments, state: next };
  }
}

/** The highlighting of one open file. */
export class DocumentHighlight {
  /** Tokens per line; `null` where not computed yet. Lines past `valid` may be stale. */
  private tokens: (Segment[] | null)[] = [];
  /** Grammar state before line `index × chunk`. */
  private checkpoints: (GrammarState | undefined)[] = [undefined];
  /** Lines before this one are up to date. */
  private valid = 0;
  private generation = 0;
  private running = false;
  private wanted = 0;
  private stopListening: () => void;

  /**
   * @param document the file
   * @param language its shiki language, or `null` for plain text
   * @param highlighter the shared highlighter
   * @param chunk lines tokenized in one go
   * @param maxLines files longer than this stay plain
   * @param onUpdate called when more lines are highlighted
   */
  constructor(
    private document: Document,
    public language: string | null,
    private highlighter: SyntaxHighlighter,
    private chunk: number,
    private maxLines: number,
    private onUpdate: () => void,
  ) {
    this.tokens = new Array(document.lines.length).fill(null);
    this.stopListening = document.onChange((start, removed, inserted) => {
      this.tokens.splice(start, removed, ...new Array(inserted).fill(null));
      this.valid = Math.min(this.valid, start);
      this.checkpoints.length = Math.min(
        this.checkpoints.length,
        Math.floor(start / this.chunk) + 1,
      );
      this.generation++;
    });
  }

  /**
   * Switches to another theme's highlighter; everything is highlighted again.
   * @param highlighter the new highlighter
   */
  retheme(highlighter: SyntaxHighlighter) {
    this.highlighter = highlighter;
    this.tokens = new Array(this.document.lines.length).fill(null);
    this.checkpoints = [undefined];
    this.valid = 0;
    this.generation++;
  }

  /** Stops following the document. */
  dispose() {
    this.stopListening();
    this.generation++;
  }

  /**
   * @param line a line index
   * @returns its coloured pieces when they match the line's current text, otherwise `null` (draw it plain)
   */
  line(line: number): Segment[] | null {
    const segments = this.tokens[line];
    if (!segments) return null;
    const text = this.document.lines[line];
    let length = 0;
    for (const segment of segments) length += segment.text.length;
    return length === text.length ? segments : null;
  }

  /**
   * Highlights up to a line in the background; repeated requests while one runs just raise its target.
   * @param upTo the first line not needed
   */
  request(upTo: number) {
    if (!this.language || this.document.lines.length > this.maxLines) return;
    this.wanted = Math.max(
      Math.min(upTo, this.document.lines.length),
      this.wanted,
    );
    if (!this.running) void this.run();
  }

  private async run() {
    this.running = true;
    try {
      const core = await this.highlighter.ready(this.language!);
      if (!core) return;
      while (this.valid < Math.min(this.wanted, this.document.lines.length)) {
        const generation = this.generation;
        const index = Math.floor(this.valid / this.chunk);
        const start = index * this.chunk;
        const lines = this.document.lines.slice(start, start + this.chunk);
        const { segments, state } = this.highlighter.tokenize(
          core,
          this.language!,
          lines,
          this.checkpoints[index],
        );
        if (generation === this.generation) {
          for (let offset = 0; offset < segments.length; offset++)
            this.tokens[start + offset] = segments[offset];
          this.checkpoints[index + 1] = state;
          this.valid = start + lines.length;
          this.onUpdate();
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      this.running = false;
      this.wanted = 0;
    }
  }
}
