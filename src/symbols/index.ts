/**
 * The symbols of a file for Go to Symbol (`@` in Quick Open) and sticky
 * scroll: declarations found by their shape, as an outline without a
 * language server (functions, classes, interfaces, types, methods, exported
 * constants, Markdown headings, CSS selectors).
 */

/** One symbol: its name, kind and line. */
export interface FileSymbol {
  name: string;
  kind: string;
  line: number;
}

/** Declaration shapes in order of preference; the first group is the kind, the second the name. */
const PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function)\*?\s+([\w$]+)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|type|namespace|module)\s+([\w$]+)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>/,
  /^\s*(?:export\s+)(const|let|var)\s+([\w$]+)/,
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+|override\s+|readonly\s+)*([\w$]+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
  /^\s*(def|class)\s+(\w+)/,
  /^\s*(?:pub\s+)?(fn|struct|enum|trait|impl|mod)\s+(\w+)/,
  /^\s*(func)\s+(?:\([^)]*\)\s*)?(\w+)/,
  /^(#{1,6})\s+(.+)$/,
  /^([.#]?[\w-][^{]*?)\s*\{\s*$/,
];

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "else",
  "do",
  "try",
  "with",
]);

/**
 * Finds the symbols of a file.
 * @param lines the file's lines
 * @param language its shiki language, so Markdown headings and CSS rules are read only where they mean that
 * @returns the symbols in line order
 */
export const fileSymbols = (
  lines: string[],
  language: string | null,
): FileSymbol[] => {
  const symbols: FileSymbol[] = [];
  const markdown = language === "markdown" || language === "mdx";
  const styles =
    language === "css" || language === "scss" || language === "less";
  lines.forEach((text, line) => {
    if (markdown) {
      const heading = /^(#{1,6})\s+(.+)$/.exec(text);
      if (heading)
        symbols.push({
          name: heading[2].trim(),
          kind: `h${heading[1].length}`,
          line,
        });
      return;
    }
    if (styles) {
      const rule = /^\s*([^/@\s][^{]*?)\s*\{\s*$/.exec(text);
      if (rule) symbols.push({ name: rule[1], kind: "selector", line });
      return;
    }
    for (const [index, pattern] of PATTERNS.slice(0, 8).entries()) {
      const match = pattern.exec(text);
      if (!match) continue;
      if (index === 2) symbols.push({ name: match[1], kind: "function", line });
      else if (index === 4) {
        if (!KEYWORDS.has(match[1]))
          symbols.push({ name: match[1], kind: "method", line });
      } else
        symbols.push({
          name: match[2],
          kind: match[1] === "def" ? "function" : match[1],
          line,
        });
      break;
    }
  });
  return symbols;
};

/**
 * The lines sticky scroll pins at the top: the openers of the blocks the first visible line is inside, as VS Code
 * finds them, by indentation: each line above with less indent that opens a block.
 * @param lines the file's lines
 * @param top the first visible line
 * @param limit the most lines pinned
 * @returns line indexes, outermost first
 */
export const stickyLines = (lines: string[], top: number, limit: number) => {
  const indentOf = (text: string) =>
    /^[ \t]*/.exec(text)![0].replace(/\t/g, "    ").length;
  const pinned: number[] = [];
  let line = top;
  while (line < lines.length && !lines[line].trim()) line++;
  let indent = line < lines.length ? indentOf(lines[line]) : 0;
  for (
    let above = Math.min(line, lines.length) - 1;
    above >= 0 && indent > 0;
    above--
  ) {
    const text = lines[above];
    if (!text.trim()) continue;
    const own = indentOf(text);
    if (own < indent) {
      if (
        /[{([:]\s*$|=>\s*$/.test(text) ||
        /^\s*(def|class|if|for|while|with|try|elif|else)\b/.test(text)
      )
        pinned.unshift(above);
      indent = own;
    }
  }
  return pinned.filter((index) => index < top).slice(-limit);
};
