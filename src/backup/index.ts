/**
 * Hot exit, as VS Code's `files.hotExit`: the text of every file with unsaved
 * changes is kept in a backup beside the user settings while codeee runs and
 * when it quits, and put back into its tab the next time the folder opens, so
 * quitting never asks and a crash never loses an edit.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { userSettingsPath } from "@/config";

/** One kept file. */
export interface Backup {
  path: string;
  text: string;
  /** The file's modification time when the edits began, to tell whether it changed on disk since. */
  modified: number;
}

const folder = () => join(dirname(userSettingsPath()), "backups");

const fileOf = (path: string) =>
  join(folder(), `${createHash("sha1").update(path).digest("hex")}.json`);

/**
 * Keeps a file's unsaved text, replacing its earlier backup in one rename.
 * @param backup the file, its text and its modification time
 */
export const writeBackup = (backup: Backup) => {
  mkdirSync(folder(), { recursive: true });
  const target = fileOf(backup.path);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(backup));
  renameSync(temporary, target);
};

/** Drops a file's backup, once it is saved or its changes are discarded. */
export const removeBackup = (path: string) =>
  rmSync(fileOf(path), { force: true });

/** @returns every kept backup; unreadable ones are skipped */
export const readBackups = (): Backup[] => {
  try {
    return readdirSync(folder())
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          return [
            JSON.parse(readFileSync(join(folder(), name), "utf8")) as Backup,
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};
