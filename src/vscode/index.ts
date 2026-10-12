/**
 * The settings of the VS Code on this machine, mapped onto codeee's: with
 * `settings.followVsCode` on, codeee starts from VS Code's editor, files,
 * explorer and workbench settings, and the user's own codeee settings sit on
 * top. Read synchronously once per configuration load from the first settings
 * file of VS Code, its Insiders build, VSCodium or Cursor.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";

const root = () =>
  platform() === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : platform() === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));

/** @returns VS Code's user settings, or an empty object when there is no VS Code-family editor */
export const readVsCodeSettings = (): Record<string, unknown> => {
  for (const editor of ["Code", "Code - Insiders", "VSCodium", "Cursor"]) {
    const path = join(root(), editor, "User", "settings.json");
    if (!existsSync(path)) continue;
    try {
      return (parse(readFileSync(path, "utf8")) ?? {}) as Record<
        string,
        unknown
      >;
    } catch {
      return {};
    }
  }
  return {};
};

/** @returns the names a VS Code exclusion object turns on (`{"**\/.git": true}` gives `.git`) */
const excludedNames = (value: unknown) =>
  value && typeof value === "object"
    ? Object.entries(value as Record<string, unknown>)
        .filter(([, on]) => on === true)
        .map(([glob]) => glob.replace(/^\*\*\//, "").replace(/\/\*\*$/, ""))
        .filter((name) => /^[^*/?{}[\]]+$/.test(name))
    : [];

/**
 * Maps VS Code's settings onto codeee's configuration shape.
 * @param vscode VS Code's user settings
 * @returns a partial configuration holding only the values VS Code sets
 */
export const fromVsCode = (vscode: Record<string, unknown>) => {
  const settings: Record<string, unknown> = {};
  const limits: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) settings[key] = value;
  };
  const bool = (key: string) =>
    typeof vscode[key] === "boolean" ? vscode[key] : undefined;
  const word = (key: string) =>
    typeof vscode[key] === "string" ? (vscode[key] as string) : undefined;
  if (typeof vscode["editor.tabSize"] === "number")
    set("tabSize", vscode["editor.tabSize"]);
  set("insertSpaces", bool("editor.insertSpaces"));
  set("detectIndentation", bool("editor.detectIndentation"));
  if (word("editor.wordWrap"))
    set("wordWrap", word("editor.wordWrap") !== "off");
  const whitespace = word("editor.renderWhitespace");
  if (whitespace)
    set(
      "renderWhitespace",
      whitespace === "none" || whitespace === "selection" ? whitespace : "all",
    );
  set("minimap", bool("editor.minimap.enabled"));
  const numbers = word("editor.lineNumbers");
  if (numbers) {
    set("lineNumbers", numbers !== "off");
    set("relativeLineNumbers", numbers === "relative");
  }
  set("formatOnSave", bool("editor.formatOnSave"));
  const autoSave = word("files.autoSave");
  if (autoSave)
    set("autoSave", autoSave === "onWindowChange" ? "onFocusChange" : autoSave);
  if (typeof vscode["files.autoSaveDelay"] === "number")
    limits.autoSaveDelayMs = vscode["files.autoSaveDelay"];
  set("trimTrailingWhitespace", bool("files.trimTrailingWhitespace"));
  set("insertFinalNewline", bool("files.insertFinalNewline"));
  const hotExit = word("files.hotExit");
  if (hotExit) set("hotExit", hotExit === "off" ? "off" : "onExit");
  set("confirmDelete", bool("explorer.confirmDelete"));
  set("compactFolders", bool("explorer.compactFolders"));
  set("wrapTabs", bool("workbench.editor.wrapTabs"));
  const folding = word("editor.showFoldingControls");
  if (folding)
    set("showFoldingControls", folding === "always" ? "always" : "mouseover");
  set("breadcrumbs", bool("breadcrumbs.enabled"));
  set("stickyScroll", bool("editor.stickyScroll.enabled"));
  set(
    "bracketPairColorization",
    bool("editor.bracketPairColorization.enabled"),
  );
  set("guides", bool("editor.guides.indentation"));
  set("colorDecorators", bool("editor.colorDecorators"));
  if (word("editor.renderLineHighlight"))
    set("highlightLine", word("editor.renderLineHighlight") !== "none");
  if (word("editor.autoClosingBrackets"))
    set("autoClosingBrackets", word("editor.autoClosingBrackets") !== "never");
  if (word("editor.autoIndent"))
    set("autoIndent", word("editor.autoIndent") !== "none");
  const exclude = excludedNames(vscode["files.exclude"]);
  if (exclude.length) set("exclude", exclude);
  const searchExclude = excludedNames(vscode["search.exclude"]);
  if (searchExclude.length) set("searchExclude", searchExclude);
  return { settings, limits };
};
