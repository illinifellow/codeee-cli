/**
 * What git says about the opened folder, for the explorer's decorations as
 * VS Code draws them: each changed file's state (modified, added, untracked,
 * deleted, renamed, conflicted), the folders that hold changes, and the files
 * git ignores. Read with one `git status` per refresh; a folder outside a
 * repository has no decorations.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A file's state, as VS Code's explorer letters it. */
export type GitState =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "renamed"
  | "conflicted"
  | "ignored";

/** The letter VS Code shows beside a file in each state. */
export const GIT_LETTERS: Record<GitState, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
  ignored: "",
};

/** Which state wins when a folder holds several: the one VS Code colours it by. */
const RANK: GitState[] = [
  "conflicted",
  "modified",
  "deleted",
  "renamed",
  "added",
  "untracked",
];

/** Git's view of a folder. */
export interface GitStatus {
  /** States by absolute path; folders carry the strongest state inside them. */
  files: Map<string, GitState>;
  folders: Map<string, GitState>;
  /** Ignored paths; a folder here covers everything below it. */
  ignored: Set<string>;
}

const run = (args: string[], cwd: string) =>
  new Promise<string | null>((resolve) =>
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout),
    ),
  );

/** @returns the state of one porcelain entry's two status letters */
const stateOf = (index: string, worktree: string): GitState => {
  const pair = index + worktree;
  if (pair === "??") return "untracked";
  if (pair === "!!") return "ignored";
  if (/U|AA|DD/.test(pair)) return "conflicted";
  if (index === "R" || worktree === "R") return "renamed";
  if (index === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  return "modified";
};

/**
 * Reads the status of the repository a folder is in.
 * @param folder the opened folder
 * @returns the decorations, or `null` when the folder is not in a repository or git is missing
 */
export const readGitStatus = async (
  folder: string,
): Promise<GitStatus | null> => {
  const top = await run(["rev-parse", "--show-toplevel"], folder);
  if (!top) return null;
  const root = top.trim();
  const output = await run(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ],
    root,
  );
  if (output === null) return null;
  const files = new Map<string, GitState>();
  const folders = new Map<string, GitState>();
  const ignored = new Set<string>();
  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const state = stateOf(entry[0], entry[1]);
    const path = join(root, entry.slice(3).replace(/\/$/, ""));
    if (entry[0] === "R" || entry[0] === "C") index++;
    if (state === "ignored") {
      ignored.add(path);
      continue;
    }
    files.set(path, state);
    for (
      let parent = path.slice(0, path.lastIndexOf("/"));
      parent.length >= root.length;
      parent = parent.slice(0, parent.lastIndexOf("/"))
    ) {
      const current = folders.get(parent);
      if (!current || RANK.indexOf(state) < RANK.indexOf(current))
        folders.set(parent, state);
      if (parent === root) break;
    }
  }
  return { files, folders, ignored };
};

/**
 * @param status what git said
 * @param path an absolute path
 * @returns whether git ignores the path or a folder above it
 */
export const isIgnored = (status: GitStatus, path: string) => {
  for (
    let current = path;
    current.includes("/");
    current = current.slice(0, current.lastIndexOf("/"))
  )
    if (status.ignored.has(current)) return true;
  return false;
};

/** Who last changed a line, as GitLens shows it at the end of the cursor line. */
export interface LineBlame {
  author: string;
  /** Seconds since the epoch. */
  time: number;
  summary: string;
  /** The line is not committed yet. */
  uncommitted: boolean;
  /** The author is the user git commits as here. */
  mine: boolean;
}

/**
 * Reads the blame of one line.
 * @param path the file
 * @param line 0-based line
 * @returns who changed it and when, or `null` outside a repository or for an untracked file
 */
export const blameLine = async (
  path: string,
  line: number,
): Promise<LineBlame | null> => {
  const output = await run(
    ["blame", "--porcelain", "-L", `${line + 1},${line + 1}`, "--", path],
    path.slice(0, path.lastIndexOf("/")),
  );
  if (!output) return null;
  const field = (name: string) =>
    new RegExp(`^${name} (.*)$`, "m").exec(output)?.[1] ?? "";
  const uncommitted = /^0{40}/.test(output);
  const email = (
    await run(["config", "user.email"], path.slice(0, path.lastIndexOf("/")))
  )?.trim();
  return {
    mine: Boolean(email) && field("author-mail").replace(/[<>]/g, "") === email,
    author: field("author"),
    time: Number(field("author-time")),
    summary: field("summary"),
    uncommitted,
  };
};

/**
 * @param seconds a time in seconds since the epoch
 * @param now the present, in milliseconds
 * @returns how long ago, as GitLens words it: `3 minutes ago`, `2 years ago`
 */
export const timeAgo = (seconds: number, now = Date.now()) => {
  const elapsed = Math.max(0, now / 1000 - seconds);
  const units: [string, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    const count = Math.floor(elapsed / size);
    if (count >= 1) return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  }
  return "just now";
};

/** How a line differs from the last commit, for the gutter. */
export type LineChange = "added" | "modified" | "deleted";

/**
 * Compares a file's text in the editor with its last committed version, as VS Code's gutter does.
 * @param path the file
 * @param text the text in the editor, saved or not
 * @returns changes by 0-based line (`deleted` marks the line below a removal), empty outside a repository or for
 *   an untracked file
 */
export const diffLines = async (path: string, text: string) => {
  const changes = new Map<number, LineChange>();
  const folder = path.slice(0, path.lastIndexOf("/"));
  const committed = await run(
    ["show", `HEAD:./${path.slice(folder.length + 1)}`],
    folder,
  );
  if (committed === null) return changes;
  const scratch = mkdtempSync(join(tmpdir(), "codeee-diff-"));
  const [before, after] = [join(scratch, "a"), join(scratch, "b")];
  writeFileSync(before, committed);
  writeFileSync(after, text);
  const output = await runAny(
    ["diff", "--no-index", "--no-color", "-U0", before, after],
    folder,
  );
  rmSync(scratch, { recursive: true, force: true });
  for (const match of output.matchAll(
    /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm,
  )) {
    const removed = match[1] === undefined ? 1 : Number(match[1]);
    const start = Number(match[2]);
    const added = match[3] === undefined ? 1 : Number(match[3]);
    if (!added) changes.set(Math.max(0, start), "deleted");
    for (let line = 0; line < added; line++)
      changes.set(start - 1 + line, removed ? "modified" : "added");
  }
  return changes;
};

/** Runs git and returns its output even when it exits with 1, as `diff` does when files differ. */
const runAny = (args: string[], cwd: string) =>
  new Promise<string>((resolve) =>
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (_error, stdout) => resolve(stdout ?? ""),
    ),
  );

/** One line of an inline diff: unchanged, removed or added, with its line numbers on either side. */
export interface DiffRow {
  kind: "same" | "removed" | "added" | "hunk";
  text: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * The changes of a file against its last commit, as VS Code's inline diff editor shows them.
 * @param path the file
 * @param text the text in the editor
 * @param context unchanged lines kept around each change
 * @param base the text to compare with instead of the last commit, as Compare with Saved does
 * @returns the rows, or `null` outside a repository or for an untracked file
 */
export const inlineDiff = async (
  path: string,
  text: string,
  context = 3,
  base?: string,
): Promise<DiffRow[] | null> => {
  const folder = path.slice(0, path.lastIndexOf("/"));
  const committed =
    base ??
    (await run(["show", `HEAD:./${path.slice(folder.length + 1)}`], folder));
  if (committed === null) return null;
  const scratch = mkdtempSync(join(tmpdir(), "codeee-diff-"));
  const [before, after] = [join(scratch, "a"), join(scratch, "b")];
  writeFileSync(before, committed);
  writeFileSync(after, text);
  const output = await runAny(
    ["diff", "--no-index", "--no-color", `-U${context}`, before, after],
    folder,
  );
  rmSync(scratch, { recursive: true, force: true });
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of output.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!rows.length || line.startsWith("\\")) continue;
    if (line.startsWith("-"))
      rows.push({ kind: "removed", text: line.slice(1), oldLine: oldLine++ });
    else if (line.startsWith("+"))
      rows.push({ kind: "added", text: line.slice(1), newLine: newLine++ });
    else if (line.startsWith(" "))
      rows.push({
        kind: "same",
        text: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
      });
  }
  return rows;
};
