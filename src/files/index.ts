/**
 * The folder codeee opened, as the explorer and Quick Open see it: folders
 * read when they are opened and cached until the watcher says they changed,
 * the tree flattened into rows, every file walked for Quick Open with fuzzy
 * matching, reading a file with its size and binary checks, and the explorer's
 * actions (new file, new folder, rename, delete to the Trash).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  cpSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

/** One file or folder. */
export interface Entry {
  name: string;
  path: string;
  folder: boolean;
}

/** One explorer row. */
export interface Row extends Entry {
  depth: number;
  expanded: boolean;
}

/** Folders first, then files, each in natural, case-insensitive order, as VS Code's explorer sorts. */
const COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * Lists a folder.
 * @param path the folder
 * @param exclude names never listed
 * @returns folders, then files, sorted; empty when the folder cannot be read
 */
export const listFolder = (path: string, exclude: string[]): Entry[] => {
  let names: {
    name: string;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
  }[];
  try {
    names = readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries = names
    .filter((entry) => !exclude.includes(entry.name))
    .map((entry) => {
      const full = join(path, entry.name);
      let folder = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          folder = statSync(full).isDirectory();
        } catch {
          folder = false;
        }
      }
      return { name: entry.name, path: full, folder };
    });
  return entries.sort(
    (a, b) =>
      Number(b.folder) - Number(a.folder) || COLLATOR.compare(a.name, b.name),
  );
};

/** The explorer's folders: which are open, and what each held when last read. */
export class FileTree {
  private children = new Map<string, Entry[]>();
  expanded = new Set<string>();

  /**
   * @param root the opened folder
   * @param exclude names never shown
   */
  constructor(
    readonly root: string,
    public exclude: string[],
    /** Folders holding a single folder show as one row, `src/ui`, as VS Code's `explorer.compactFolders`. */
    public compact = true,
  ) {}

  /** @returns the folder's entries, read on first use */
  entries(path: string) {
    let entries = this.children.get(path);
    if (!entries) {
      entries = listFolder(path, this.exclude);
      this.children.set(path, entries);
    }
    return entries;
  }

  /** Forgets what was read, so every folder is read again on the next draw. */
  refresh() {
    this.children.clear();
    for (const path of this.expanded)
      if (!existsSync(path)) this.expanded.delete(path);
  }

  /** Opens or closes a folder. */
  toggle(path: string) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
  }

  /** Opens every folder from the root down to a path, so it shows in the tree. */
  reveal(path: string) {
    for (
      let folder = dirname(path);
      folder.startsWith(this.root) && folder !== this.root;
      folder = dirname(folder)
    )
      this.expanded.add(folder);
  }

  /** @returns every visible row, depth first */
  rows(): Row[] {
    const rows: Row[] = [];
    const walk = (path: string, depth: number) => {
      for (const entry of this.entries(path)) {
        let shown = entry;
        while (this.compact && shown.folder) {
          const children = this.entries(shown.path);
          if (children.length !== 1 || !children[0].folder) break;
          shown = { ...children[0], name: `${shown.name}/${children[0].name}` };
        }
        const expanded = shown.folder && this.expanded.has(shown.path);
        rows.push({ ...shown, depth, expanded });
        if (expanded) walk(shown.path, depth + 1);
      }
    };
    walk(this.root, 0);
    return rows;
  }
}

/**
 * Lists every file under a folder for Quick Open, breadth first.
 * @param root where to start
 * @param exclude names skipped everywhere
 * @param limit the most files returned
 * @returns paths relative to the root, with `/` separators
 */
export const walkFiles = (
  root: string,
  exclude: string[],
  limit: number,
): string[] => {
  const files: string[] = [];
  const queue = [root];
  while (queue.length && files.length < limit) {
    const folder = queue.shift()!;
    for (const entry of listFolder(folder, exclude)) {
      if (entry.folder) queue.push(entry.path);
      else files.push(relative(root, entry.path).split(sep).join("/"));
      if (files.length >= limit) break;
    }
  }
  return files;
};

/**
 * Scores a path against a Quick Open query the way VS Code does it roughly: every character of the query must
 * appear in order; runs, word starts and matches in the file name score higher.
 * @param path a relative path
 * @param query what was typed
 * @returns the score and the matched character offsets, or `null` when it does not match
 */
export const fuzzyMatch = (
  path: string,
  query: string,
): { score: number; positions: number[] } | null => {
  if (!query) return { score: 0, positions: [] };
  const lower = path.toLowerCase();
  const wanted = query.toLowerCase().replace(/\s+/g, "");
  const nameStart = path.lastIndexOf("/") + 1;
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  for (const character of wanted) {
    const found = lower.indexOf(character, from);
    if (found < 0) return null;
    const previous = positions.at(-1);
    score += 1;
    if (previous !== undefined && found === previous + 1) score += 5;
    if (
      found === 0 ||
      "/-_. ".includes(path[found - 1]) ||
      (path[found] !== lower[found] && path[found - 1] === lower[found - 1])
    )
      score += 3;
    if (found >= nameStart) score += 2;
    positions.push(found);
    from = found + 1;
  }
  if (lower.slice(nameStart).startsWith(wanted)) score += 10;
  return { score: score - path.length * 0.01, positions };
};

/** What reading a file found. */
export type FileContents =
  | { kind: "text"; text: string }
  | { kind: "binary" }
  | { kind: "large"; megabytes: number }
  | { kind: "error"; message: string };

/**
 * Reads a file for editing.
 * @param path the file
 * @param maxMegabytes larger files are not opened
 * @returns the text; or why it is not shown: binary (a NUL byte in the first 8 KB), too large, or unreadable
 */
export const readText = (path: string, maxMegabytes: number): FileContents => {
  try {
    const size = statSync(path).size;
    if (size > maxMegabytes * 1024 * 1024)
      return { kind: "large", megabytes: Math.round(size / 1024 / 1024) };
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 8192).includes(0)) return { kind: "binary" };
    const text = bytes.toString("utf8");
    return { kind: "text", text: text.startsWith("﻿") ? text.slice(1) : text };
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
};

/**
 * Writes a file in place, keeping its permissions and any link that points to it.
 * @param path the file
 * @param text the contents
 * @returns the file's modification time after writing
 */
export const writeText = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return statSync(path).mtimeMs;
};

/** @returns the file's modification time, or 0 when it is gone */
export const modifiedTime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Checks a name typed for a new or renamed entry.
 * @param folder where it goes
 * @param name what was typed; may hold `/` to create folders on the way
 * @returns the problem in words, or `null`
 */
export const nameProblem = (folder: string, name: string) => {
  const trimmed = name.trim();
  if (!trimmed) return "A file or folder name must be provided.";
  if (/(^|\/)\.\.?(\/|$)/.test(trimmed) || trimmed.startsWith("/"))
    return `The name ${trimmed} is not valid as a file or folder name.`;
  if (existsSync(join(folder, trimmed)))
    return `A file or folder ${trimmed} already exists at this location.`;
  return null;
};

/** Creates an empty file, and the folders on its way. @returns its path */
export const createFile = (folder: string, name: string) => {
  const path = join(folder, name.trim());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", { flag: "wx" });
  return path;
};

/** Creates a folder, and the folders on its way. @returns its path */
export const createFolder = (folder: string, name: string) => {
  const path = join(folder, name.trim());
  mkdirSync(path, { recursive: true });
  return path;
};

/** Renames an entry inside its folder. @returns the new path */
export const renameEntry = (path: string, name: string) => {
  const target = join(dirname(path), name.trim());
  renameSync(path, target);
  return target;
};

/**
 * Deletes an entry: into the Trash on macOS (`~/.Trash`, renamed when the name is taken), permanently elsewhere.
 * @param path what to delete
 * @returns `trash` or `deleted`
 */
export const deleteEntry = (path: string): "trash" | "deleted" => {
  const trash = join(homedir(), ".Trash");
  if (process.platform === "darwin" && existsSync(trash)) {
    const extension = extname(path);
    let target = join(trash, basename(path));
    for (let index = 2; existsSync(target); index++)
      target = join(trash, `${basename(path, extension)} ${index}${extension}`);
    try {
      renameSync(path, target);
    } catch {
      cpSync(path, target, { recursive: true });
      rmSync(path, { recursive: true, force: true });
    }
    return "trash";
  }
  rmSync(path, { recursive: true, force: true });
  return "deleted";
};

/**
 * Watches the folder for changes made outside codeee.
 * @param root the folder
 * @param exclude names whose changes are ignored (`.git` and the like)
 * @param debounceMs changes closer than this are reported once
 * @param onChange receives the changed paths
 * @returns the watcher, or `null` where recursive watching is not available
 */
export const watchFolder = (
  root: string,
  exclude: string[],
  debounceMs: number,
  onChange: (paths: string[]) => void,
): FSWatcher | null => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = new Set<string>();
  try {
    const watcher = watch(root, { recursive: true }, (_event, file) => {
      if (!file) return;
      const name = String(file);
      if (name.split(/[\\/]/).some((part) => exclude.includes(part))) return;
      changed.add(join(root, name));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const paths = [...changed];
        changed.clear();
        onChange(paths);
      }, debounceMs);
    });
    watcher.on("error", () => watcher.close());
    return watcher;
  } catch {
    return null;
  }
};

/**
 * @param path a path as typed, `~` allowed
 * @returns the absolute path
 */
export const expandPath = (path: string) =>
  resolve(path.replace(/^~(?=$|\/)/, homedir()));
