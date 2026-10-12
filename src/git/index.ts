/**
 * What git says about the opened folder, for the explorer's decorations as
 * VS Code draws them: each changed file's state (modified, added, untracked,
 * deleted, renamed, conflicted), the folders that hold changes, and the files
 * git ignores. Read with one `git status` per refresh; a folder outside a
 * repository has no decorations.
 */
import { execFile } from "node:child_process";
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
