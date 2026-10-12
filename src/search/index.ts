/**
 * Search across the opened folder, as VS Code's Search view: every text file
 * under it except the excluded names (and `files to include` / `files to
 * exclude` globs), matched by text or regular expression with the case and
 * whole-word options, results grouped by file, found in the background and
 * reported as they come. Replace writes the files that are not open and edits
 * the open ones, leaving them unsaved, as VS Code does.
 */
import { readFile, writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { preserveCase, type FindOptions } from "@/buffer";
import { walkFiles } from "@/files";

/** One match in a file. */
export interface SearchMatch {
  line: number;
  start: number;
  end: number;
  /** The whole line, for the preview. */
  text: string;
}

/** The matches of one file. */
export interface FileResult {
  path: string;
  matches: SearchMatch[];
}

/** What to search for and where. */
export interface SearchQuery extends FindOptions {
  query: string;
  /** Comma-separated globs a file's relative path must match; empty for every file. */
  include: string;
  /** Comma-separated globs of files to leave out. */
  exclude: string;
}

/** @returns a regular expression for a glob: `*` within a name, `**` across folders, a bare name anywhere */
const globPattern = (glob: string) => {
  const trimmed = glob.trim().replace(/^\.\//, "");
  const source = trimmed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(
    trimmed.includes("/") ? `^${source}(/.*)?$` : `(^|/)${source}(/.*)?$`,
    "i",
  );
};

/** @returns the globs of a comma-separated list as expressions */
const globs = (list: string) =>
  list
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean)
    .map(globPattern);

/**
 * @param query the search
 * @returns the expression it matches with, or `null` for an empty or invalid one
 */
export const searchPattern = (query: SearchQuery) => {
  if (!query.query) return null;
  try {
    const source = query.regex
      ? query.query
      : query.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      query.wholeWord
        ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
        : source,
      `gu${query.caseSensitive ? "" : "i"}`,
    );
  } catch {
    return null;
  }
};

/**
 * Searches the folder.
 * @param root the opened folder
 * @param query what and where
 * @param options.exclude names never searched (the explorer's and Quick Open's exclusions)
 * @param options.maxFiles the most files looked at
 * @param options.maxMatches the most matches collected
 * @param options.maxBytes files larger than this are skipped
 * @param options.signal aborting stops the search between files
 * @param options.onProgress receives the results so far, about every 50 files
 * @returns every file with matches, in path order; rejects only on an invalid regular expression
 */
export const searchFolder = async (
  root: string,
  query: SearchQuery,
  options: {
    exclude: string[];
    maxFiles: number;
    maxMatches: number;
    maxBytes: number;
    signal?: AbortSignal;
    onProgress?: (results: FileResult[]) => void;
  },
): Promise<FileResult[]> => {
  const pattern = searchPattern(query);
  if (!pattern) {
    if (query.query && query.regex)
      throw new Error("The regular expression is not valid");
    return [];
  }
  const include = globs(query.include);
  const excluded = globs(query.exclude);
  const files = walkFiles(root, options.exclude, options.maxFiles).filter(
    (path) =>
      (!include.length || include.some((glob) => glob.test(path))) &&
      !excluded.some((glob) => glob.test(path)),
  );
  const results: FileResult[] = [];
  let found = 0;
  for (
    let index = 0;
    index < files.length && found < options.maxMatches;
    index++
  ) {
    if (options.signal?.aborted) break;
    const absolute = `${root}${sep}${files[index].split("/").join(sep)}`;
    const bytes = await readFile(absolute).catch(() => null);
    if (
      !bytes ||
      bytes.length > options.maxBytes ||
      bytes.subarray(0, 8192).includes(0)
    )
      continue;
    const lines = bytes.toString("utf8").split(/\r?\n/);
    const matches: SearchMatch[] = [];
    for (
      let line = 0;
      line < lines.length && found < options.maxMatches;
      line++
    ) {
      pattern.lastIndex = 0;
      for (const match of lines[line].matchAll(pattern)) {
        if (!match[0].length) continue;
        matches.push({
          line,
          start: match.index,
          end: match.index + match[0].length,
          text: lines[line],
        });
        found++;
      }
    }
    if (matches.length) results.push({ path: absolute, matches });
    if (index % 50 === 49) {
      options.onProgress?.([...results]);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return results;
};

/**
 * Applies the replacement to one line's matches.
 * @param text the line
 * @param matches its matches, in order
 * @param replacement the new text; with a regular expression, `$1` and `$&` refer to the match
 * @param pattern the search's expression, for group references
 * @returns the line after replacing
 */
export const replaceInLine = (
  text: string,
  matches: { start: number; end: number }[],
  replacement: string,
  pattern: RegExp | null,
  keepCase = false,
) => {
  let result = text;
  for (const match of [...matches].sort((a, b) => b.start - a.start)) {
    const found = result.slice(match.start, match.end);
    const value = pattern
      ? found.replace(
          new RegExp(pattern.source, pattern.flags.replace("g", "")),
          replacement,
        )
      : replacement;
    const final = keepCase ? preserveCase(found, value) : value;
    result = result.slice(0, match.start) + final + result.slice(match.end);
  }
  return result;
};

/**
 * Replaces the matches of a file on disk, keeping its line endings; lines that changed since the search are left alone.
 * @param result the file and its matches
 * @param replacement the new text
 * @param pattern the search's expression, for group references
 * @returns how many matches were replaced
 */
export const replaceInFile = async (
  result: FileResult,
  replacement: string,
  pattern: RegExp | null,
  keepCase = false,
) => {
  const text = await readFile(result.path, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let count = 0;
  const byLine = new Map<number, SearchMatch[]>();
  for (const match of result.matches)
    byLine.set(match.line, [...(byLine.get(match.line) ?? []), match]);
  for (const [line, matches] of byLine) {
    if (lines[line] !== matches[0].text) continue;
    lines[line] = replaceInLine(
      lines[line],
      matches,
      replacement,
      pattern,
      keepCase,
    );
    count += matches.length;
  }
  await writeFile(result.path, lines.join(eol));
  return count;
};

/** @returns a path relative to the root with `/` separators, for display */
export const shownPath = (root: string, path: string) =>
  relative(root, path).split(sep).join("/");
