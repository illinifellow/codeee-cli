/**
 * Snippets from VS Code: every snippet file the installed extensions
 * contribute (`contributes.snippets`) and the user's own snippet files, by
 * language. Typing a snippet's prefix and pressing Tab inserts its body with
 * the placeholders filled with their defaults and the cursor at the first
 * tab stop, indented like the line it starts on.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { parse } from "jsonc-parser";
import { toShiki } from "@/languages";

/** One snippet. */
export interface Snippet {
  prefix: string;
  body: string;
  description: string;
}

/** Snippets by shiki language; `*` holds the ones for every language. */
const SNIPPETS = new Map<string, Map<string, Snippet>>();

/** Languages a JavaScript snippet also applies to, as the React snippet extensions declare them one by one. */
const RELATED: Record<string, string[]> = {
  javascript: ["jsx"],
  typescript: ["tsx"],
  jsx: ["javascript"],
  tsx: ["typescript"],
};

const EXTENSION_ROOTS = [
  join(homedir(), ".vscode", "extensions"),
  join(homedir(), ".cursor", "extensions"),
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
];

const USER_SNIPPETS = [
  join(homedir(), "Library", "Application Support", "Code", "User", "snippets"),
  join(homedir(), ".config", "Code", "User", "snippets"),
];

const add = (language: string, file: string) => {
  let entries: Record<
    string,
    {
      prefix?: string | string[];
      body?: string | string[];
      description?: string;
      scope?: string;
    }
  >;
  try {
    entries = parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    return;
  }
  for (const entry of Object.values(entries)) {
    if (!entry?.prefix || entry.body === undefined) continue;
    const languages = entry.scope
      ? entry.scope.split(",").map((scope) => scope.trim())
      : [language];
    for (const scope of languages) {
      const shiki = scope === "*" ? "*" : toShiki(scope);
      if (!shiki) continue;
      for (const target of [shiki, ...(RELATED[shiki] ?? [])]) {
        const table = SNIPPETS.get(target) ?? new Map<string, Snippet>();
        for (const prefix of [entry.prefix].flat())
          if (!table.has(prefix))
            table.set(prefix, {
              prefix,
              body: [entry.body].flat().join("\n"),
              description: entry.description ?? "",
            });
        SNIPPETS.set(target, table);
      }
    }
  }
};

/** Reads every snippet file once; later calls do nothing. */
export const loadSnippets = () => {
  if (SNIPPETS.size) return;
  for (const folder of USER_SNIPPETS) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder))
      add(
        extname(name) === ".code-snippets"
          ? "*"
          : basename(name, extname(name)),
        join(folder, name),
      );
  }
  for (const root of EXTENSION_ROOTS) {
    if (!existsSync(root)) continue;
    for (const folder of readdirSync(root)) {
      try {
        const manifest = JSON.parse(
          readFileSync(join(root, folder, "package.json"), "utf8"),
        ) as {
          contributes?: { snippets?: { language?: string; path: string }[] };
        };
        for (const entry of manifest.contributes?.snippets ?? [])
          add(entry.language ?? "*", join(root, folder, entry.path));
      } catch {
        // an extension without a readable manifest has no snippets
      }
    }
  }
};

/**
 * @param language the file's shiki language
 * @param prefix the word before the cursor
 * @returns the snippet that prefix names, if any
 */
export const findSnippet = (language: string | null, prefix: string) =>
  (language && SNIPPETS.get(language)?.get(prefix)) ||
  SNIPPETS.get("*")?.get(prefix);

/**
 * Turns a snippet body into text: placeholders become their defaults, choices their first option, variables their
 * values; tabs and line breaks follow the line's indent.
 * @param body the snippet body
 * @param context the file name and the indent of the line the snippet starts on, one indent unit
 * @returns the text, the offset in it where the cursor goes (the first tab stop, else `$0`, else the end), and how
 *   many characters after it are selected (the first placeholder's default, which typing replaces)
 */
export const expandSnippet = (
  body: string,
  context: { fileName: string; indent: string; unit: string },
) => {
  const variables: Record<string, string> = {
    TM_FILENAME: context.fileName,
    TM_FILENAME_BASE: context.fileName.replace(/\.[^.]*$/, ""),
    CURRENT_YEAR: String(new Date().getFullYear()),
  };
  let text = "";
  const stops = new Map<number, number>();
  const lengths = new Map<number, number>();
  const read = (source: string): string => {
    let out = "";
    for (let index = 0; index < source.length; index++) {
      const character = source[index];
      if (character === "\\" && index + 1 < source.length) {
        out += source[++index];
        continue;
      }
      if (character !== "$") {
        out += character;
        continue;
      }
      const simple = /^(\d+)|^([A-Z_]+)/.exec(source.slice(index + 1));
      if (simple) {
        if (simple[1] !== undefined && !stops.has(Number(simple[1])))
          stops.set(Number(simple[1]), text.length + out.length);
        if (simple[2] !== undefined) out += variables[simple[2]] ?? "";
        index += simple[0].length;
        continue;
      }
      if (source[index + 1] !== "{") {
        out += character;
        continue;
      }
      let depth = 0;
      let end = index + 1;
      for (; end < source.length; end++) {
        if (source[end] === "{") depth++;
        if (source[end] === "}" && --depth === 0) break;
      }
      const inner = source.slice(index + 2, end);
      const match = /^(\d+|[A-Z_]+)(?::([\s\S]*)|\|([^|]*)\|)?$/.exec(inner);
      if (match) {
        const number = Number(match[1]);
        if (!Number.isNaN(number) && !stops.has(number))
          stops.set(number, text.length + out.length);
        const fallback =
          match[3] !== undefined
            ? match[3].split(",")[0]
            : match[2] !== undefined
              ? read(match[2])
              : "";
        if (!Number.isNaN(number) && !lengths.has(number))
          lengths.set(number, fallback.length);
        out += Number.isNaN(number)
          ? (variables[match[1]] ?? fallback)
          : fallback;
      }
      index = end;
    }
    return out;
  };
  text = read(body);
  const lines = text.split("\n");
  const firstStop = [...stops.keys()]
    .filter((number) => number > 0)
    .sort((a, b) => a - b)[0];
  const target =
    [...stops.entries()]
      .filter(([number]) => number > 0)
      .sort((a, b) => a[0] - b[0])[0]?.[1] ??
    stops.get(0) ??
    text.length;
  const before = text.slice(0, target).split("\n");
  const cursorLine = before.length - 1;
  const cursorColumn = before[cursorLine].length;
  const shapedLines = lines.map(
    (line, index) =>
      (index ? context.indent : "") +
      line.replace(/^\t+/, (tabs) => context.unit.repeat(tabs.length)),
  );
  /** Maps an offset in the unshaped text to the shaped text. */
  const shape = (offset: number) => {
    const head = text.slice(0, offset).split("\n");
    const line = head.length - 1;
    const columnRaw = head[line].length;
    const tabs = lines[line].match(/^\t*/)![0].length;
    const column =
      (line ? context.indent.length : 0) +
      (columnRaw >= tabs
        ? columnRaw + tabs * (context.unit.length - 1)
        : columnRaw * context.unit.length);
    return (
      shapedLines
        .slice(0, line)
        .reduce((total, shaped) => total + shaped.length + 1, 0) + column
    );
  };
  void cursorColumn;
  const cursor = shape(target);
  const order = [...stops.keys()]
    .filter((number) => number > 0)
    .sort((a, b) => a - b);
  if (stops.has(0)) order.push(0);
  const placeholders = order.map((number) => ({
    offset: shape(stops.get(number)!),
    length: lengths.get(number) ?? 0,
  }));
  return {
    text: shapedLines.join("\n"),
    cursor,
    selected: firstStop === undefined ? 0 : (lengths.get(firstStop) ?? 0),
    /** Every tab stop in order (`$0` last), as offsets in the text with the length of its placeholder. */
    placeholders,
  };
};

/**
 * @param language the file's shiki language
 * @returns every snippet that applies to it, for the suggestion list
 */
export const snippetsFor = (language: string | null): Snippet[] => [
  ...((language && SNIPPETS.get(language)?.values()) || []),
  ...(SNIPPETS.get("*")?.values() ?? []),
];
