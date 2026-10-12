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
