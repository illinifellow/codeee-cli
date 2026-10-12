/**
 * ESLint diagnostics, as the VS Code ESLint extension shows them: the
 * project's own ESLint and configuration lint the text as it is in the editor,
 * saved or not. Projects without ESLint get no diagnostics.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** One problem ESLint found, with 0-based lines and UTF-16 columns. */
export interface Diagnostic {
  line: number;
  start: number;
  endLine: number;
  end: number;
  severity: "error" | "warning";
  message: string;
  rule: string | null;
}

/** Files ESLint is asked about, as the extension's default `eslint.validate`. */
const LINTED = /\.(m|c)?(j|t)sx?$|\.vue$|\.svelte$|\.astro$/i;

/**
 * @param path a file in the project
 * @returns the project's ESLint script and the folder to run it in, or `null` when the project has none
 */
export const findEslint = (path: string) => {
  for (let folder = dirname(path); ; folder = dirname(folder)) {
    const script = join(folder, "node_modules", "eslint", "bin", "eslint.js");
    if (existsSync(script)) return { script, folder };
    if (dirname(folder) === folder) return null;
  }
};

/**
 * Lints a file's current text.
 * @param path the file, for its configuration and parser
 * @param text the text in the editor
 * @returns the problems; empty when the file is not linted, the project has no ESLint, or ESLint fails
 */
export const lintText = (path: string, text: string) =>
  new Promise<Diagnostic[]>((resolve) => {
    const eslint = LINTED.test(path) ? findEslint(path) : null;
    if (!eslint) return resolve([]);
    const child = execFile(
      process.execPath,
      [eslint.script, "--format", "json", "--stdin", "--stdin-filename", path],
      { cwd: eslint.folder, maxBuffer: 32 * 1024 * 1024 },
      (_error, stdout) => {
        try {
          const [result] = JSON.parse(stdout) as {
            messages: {
              line?: number;
              column?: number;
              endLine?: number;
              endColumn?: number;
              severity: number;
              message: string;
              ruleId: string | null;
            }[];
          }[];
          resolve(
            (result?.messages ?? []).map((message) => ({
              line: (message.line ?? 1) - 1,
              start: (message.column ?? 1) - 1,
              endLine: (message.endLine ?? message.line ?? 1) - 1,
              end: (message.endColumn ?? (message.column ?? 1) + 1) - 1,
              severity: message.severity === 2 ? "error" : "warning",
              message: message.message,
              rule: message.ruleId,
            })),
          );
        } catch {
          resolve([]);
        }
      },
    );
    child.stdin?.end(text);
  });
