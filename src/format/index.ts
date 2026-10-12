/**
 * Format Document the way VS Code does it with the Prettier extension: the
 * project's own Prettier and configuration when the project has them, otherwise
 * the Prettier the VS Code extension bundles, otherwise one on `PATH`. The
 * file's path decides the parser and which configuration and ignore files
 * apply, exactly as in the editor.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Extension folders holding the Prettier extension, newest version last when sorted. */
const EXTENSION_ROOTS = [
  join(homedir(), ".vscode", "extensions"),
  join(homedir(), ".vscode-insiders", "extensions"),
  join(homedir(), ".cursor", "extensions"),
  join(homedir(), ".vscode-oss", "extensions"),
];

/**
 * Finds the Prettier that formats a file.
 * @param path the file
 * @returns the script to run with node, or `null` for the `prettier` command on `PATH`
 */
export const findPrettier = (path: string): string | null => {
  for (let folder = dirname(path); ; folder = dirname(folder)) {
    const local = join(
      folder,
      "node_modules",
      "prettier",
      "bin",
      "prettier.cjs",
    );
    if (existsSync(local)) return local;
    if (dirname(folder) === folder) break;
  }
  for (const root of EXTENSION_ROOTS) {
    if (!existsSync(root)) continue;
    const extension = readdirSync(root)
      .filter((name) => name.startsWith("esbenp.prettier-vscode-"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1);
    const bundled =
      extension &&
      join(root, extension, "node_modules", "prettier", "bin", "prettier.cjs");
    if (bundled && existsSync(bundled)) return bundled;
  }
  return null;
};

/**
 * Formats text as Prettier formats the file.
 * @param path the file, for the parser, configuration and `.prettierignore`
 * @param text the current contents
 * @param range only format the code within these character offsets, as Format Selection
 * @returns the formatted text; rejects with Prettier's own message when it cannot parse the file or is not found
 */
export const formatText = (
  path: string,
  text: string,
  range?: [number, number],
) =>
  new Promise<string>((resolve, reject) => {
    const script = findPrettier(path);
    const extra = range
      ? ["--range-start", String(range[0]), "--range-end", String(range[1])]
      : [];
    const [command, args] = script
      ? [process.execPath, [script, "--stdin-filepath", path, ...extra]]
      : ["prettier", ["--stdin-filepath", path, ...extra]];
    const child = execFile(
      command,
      args,
      { cwd: dirname(path), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const message =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "Prettier was not found: install it in the project or the Prettier extension in VS Code"
            : stderr.trim().split("\n").slice(0, 2).join(" ") || error.message;
        reject(new Error(message));
      },
    );
    child.stdin?.end(text);
  });
