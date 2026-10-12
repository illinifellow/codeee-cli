/**
 * One settings file in two places, of the same shape. `config/settings.json`,
 * shipped with codeee, holds every default: editor settings, limits, the
 * explorer width, key bindings, the themes and an empty `state`.
 * `~/.config/codeee-cli/settings.json` holds only what the user changed and what
 * codeee remembers (`state`: the tabs open in each folder); it
 * may carry comments and trailing commas. The two are merged on load and every
 * value is checked against the type and range of its default; saving edits only
 * the values that changed, keeps the user's comments, and replaces the file in
 * one rename so a crash never leaves it half written. A user file that cannot
 * be parsed is never overwritten: codeee runs on the defaults and says why.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import type { ThemeOverrides } from "@/theme";

/** Every action a key can trigger. */
export type KeyBindings = Record<
  | "save"
  | "quit"
  | "close"
  | "newFile"
  | "quickOpen"
  | "goToLine"
  | "find"
  | "replace"
  | "explorer"
  | "focusExplorer"
  | "settings"
  | "undo"
  | "redo"
  | "copy"
  | "cut"
  | "paste"
  | "selectAll"
  | "selectLine"
  | "deleteLine"
  | "duplicateLine"
  | "comment"
  | "format"
  | "goToSymbol"
  | "nextProblem"
  | "previousProblem"
  | "search"
  | "replaceInFiles"
  | "moveLineUp"
  | "moveLineDown"
  | "nextTab"
  | "previousTab"
  | "findNext"
  | "findPrevious",
  string
>;

/** Sizes, timings and caps that shape behaviour rather than looks. */
export interface Limits {
  maxFileMegabytes: number;
  highlightChunkLines: number;
  highlightMaxLines: number;
  quickOpenFiles: number;
  undoSteps: number;
  typingGroupMs: number;
  watchDebounceMs: number;
  refreshDelayMs: number;
  doubleClickMs: number;
  doubleClickCells: number;
  inputSplitMs: number;
  backgroundQueryMs: number;
  statusMs: number;
  errorStatusMs: number;
  updateCheckHours: number;
  /** Files whose last cursor position is kept. */
  rememberedPositions: number;
  lintDelayMs: number;
  autoSaveDelayMs: number;
  /** Folders the start screen offers. */
  recentFolders: number;
}

/** Editor settings. */
export interface EditorSettings {
  /** `vscode` (the theme VS Code runs, customizations included), `auto` (by the terminal background), `golden-brown`, `milk-and-honey`, or a theme under `themes`. */
  theme: string;
  /** `vscode` takes file and folder icons from the icon theme VS Code uses; `none` draws no icons. */
  iconTheme: string;
  tabSize: number;
  insertSpaces: boolean;
  /** Reads tabs or spaces and the indent size from each file instead of `tabSize` and `insertSpaces`. */
  detectIndentation: boolean;
  lineNumbers: boolean;
  /** Line numbers counted from the cursor line, as neovim's `relativenumber`; the cursor line keeps its own number. */
  relativeLineNumbers: boolean;
  highlightLine: boolean;
  /** Shows who last changed the cursor line, and when, at its end, as GitLens's current line blame. */
  lineBlame: boolean;
  /** Draws colour literals (`#ff905c`, `rgb(…)`) on their own colour, as Color Highlight does. */
  colorDecorators: boolean;
  /** Colours matching brackets by depth, as VS Code's `editor.bracketPairColorization`. */
  bracketPairColorization: boolean;
  /** Draws indent guides. */
  guides: boolean;
  /** Shows the minimap at the editor's right edge. */
  minimap: boolean;
  /** Pins the lines that open the blocks around the top of the editor, as VS Code's sticky scroll. */
  stickyScroll: boolean;
  /** Lints JavaScript and TypeScript with the project's ESLint and shows the problems at line ends, as Error Lens. */
  eslint: boolean;
  /** Expands snippet prefixes on Tab. */
  snippets: boolean;
  /** `off`, `afterDelay` or `onFocusChange`, as VS Code's `files.autoSave`. */
  autoSave: string;
  autoIndent: boolean;
  autoClosingBrackets: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  /** Formats a file with Prettier on save, as VS Code's `editor.formatOnSave`. */
  formatOnSave: boolean;
  /** The explorer is shown. */
  explorer: boolean;
  wheelLines: number;
  /** Names never shown in the explorer or searched. */
  exclude: string[];
  /** Names shown in the explorer but left out of Quick Open. */
  searchExclude: string[];
}

/** The whole configuration, defaults and user changes merged. */
export interface Config {
  settings: EditorSettings;
  limits: Limits;
  /** The explorer's width in terminal cells. */
  columns: { explorer: number };
  keys: KeyBindings;
  /** Every theme; a theme of the user's own fills what it leaves out from the theme it `extends`. */
  themes: Record<string, ThemeOverrides>;
  /** Single values laid over the active theme. */
  tokens: ThemeOverrides;
  /** What codeee remembers between runs. */
  state: State;
}

/** The tabs left open in one folder. */
export interface Session {
  open: string[];
  active: string | null;
}

/** What codeee remembers between runs. */
export interface State {
  /** Folders opened lately, newest first. */
  recent: string[];
  /** The tabs open in each folder. */
  sessions: Record<string, Session>;
  /** The last cursor line and column in each file, by absolute path, as neovim's last-position mark; newest last. */
  positions: Record<string, [line: number, column: number]>;
}

/** The `settings.theme` value that picks a shipped theme by the terminal's background. */
export const AUTO_THEME = "auto";

/** Read at each call, so tests and a changed environment point it elsewhere. */
const userSettings = () =>
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "codeee-cli",
    "settings.json",
  );

/** How saved files are indented. */
const FORMATTING = {
  formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
};

/** Allowed values of the settings that take one of a few words. */
const CHOICES: Record<string, readonly string[]> = {
  "settings.autoSave": ["off", "afterDelay", "onFocusChange"],
  "settings.iconTheme": ["vscode", "none"],
};

/** Numbers that may be 0; every other number in `settings`, `limits` and `columns` is a whole number of at least 1. */
const ZERO_ALLOWED = new Set(["limits.refreshDelayMs", "limits.inputSplitMs"]);

/** Sections whose every value is checked against the type of its default. */
const CHECKED_SECTIONS = [
  "settings",
  "limits",
  "columns",
  "keys",
  "state",
] as const;

/** A user settings file codeee cannot read; it is left untouched. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Finds `config/settings.json` above this module: next to `dist/` when installed, next to `src/` in development. */
const defaultsPath = () => {
  let folder = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(folder, "config", "settings.json"))) {
    const parent = dirname(folder);
    if (parent === folder)
      throw new Error(
        `codeee: config/settings.json not found above ${fileURLToPath(import.meta.url)}`,
      );
    folder = parent;
  }
  return join(folder, "config", "settings.json");
};

/** @returns every default, read from `config/settings.json` */
export const loadDefaults = (): Config =>
  JSON.parse(readFileSync(defaultsPath(), "utf8")) as Config;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Lays `changes` over `base`, recursively for plain objects; arrays and other values from `changes` replace.
 * @param base the complete value
 * @param changes what to lay over it; `undefined` keeps `base`
 * @returns a new value; neither input is changed
 */
export const overlay = <Shape>(base: Shape, changes: unknown): Shape => {
  if (!isObject(base) || !isObject(changes))
    return structuredClone((changes === undefined ? base : changes) as Shape);
  const result: Record<string, unknown> = structuredClone(base) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(changes))
    result[key] = overlay(result[key], value);
  return result as Shape;
};

/** @returns what `value` has that differs from `base`, recursively; `undefined` when nothing differs */
const difference = (value: unknown, base: unknown): unknown => {
  if (isObject(value) && isObject(base)) {
    const entries = Object.entries(value)
      .map(([key, child]) => [key, difference(child, base[key])] as const)
      .filter(([, child]) => child !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
};

/** @returns 1-based line and column of an offset in `text` */
const positionOf = (text: string, offset: number) => {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1].length + 1 };
};

/**
 * Reads the user file.
 * @returns its text (empty when there is no file) and the object it holds
 * @throws ConfigError naming the file and the first problem's line and column when it cannot be read or parsed,
 *   or does not hold an object
 */
const readUserFile = (): { text: string; stored: Record<string, unknown> } => {
  let text: string;
  try {
    text = readFileSync(userSettings(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { text: "", stored: {} };
    throw new ConfigError(
      `${userSettings()} cannot be read: ${(error as Error).message}`,
    );
  }
  const errors: ParseError[] = [];
  const stored: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const { line, column } = positionOf(text, errors[0].offset);
    throw new ConfigError(
      `${userSettings()}:${line}:${column}: ${printParseErrorCode(errors[0].error)}; codeee runs on the defaults and saves nothing until it is fixed`,
    );
  }
  if (!isObject(stored) && text.trim())
    throw new ConfigError(
      `${userSettings()} must hold a JSON object; codeee runs on the defaults and saves nothing until it is fixed`,
    );
  return { text, stored: isObject(stored) ? stored : {} };
};

/** @returns a description of `value` for an error message */
const shown = (value: unknown) => JSON.stringify(value) ?? String(value);

/**
 * Checks one merged value against its default.
 * @param key dotted path, e.g. `limits.tabWidth`
 * @param value the merged value
 * @param fallback the default
 * @param config the merged configuration, for settings that name a theme or icon set
 * @returns a sentence naming the problem, or `null` when the value is usable
 */
const problemOf = (
  key: string,
  value: unknown,
  fallback: unknown,
  config: Config,
): string | null => {
  if (key === "settings.theme")
    return value === AUTO_THEME ||
      value === "vscode" ||
      (typeof value === "string" && isObject(config.themes[value]))
      ? null
      : `${key} names no theme: ${shown(value)}`;
  if (CHOICES[key])
    return CHOICES[key].includes(value as string)
      ? null
      : `${key} must be one of ${CHOICES[key].join(", ")}, found ${shown(value)}`;
  if (fallback === null)
    return value === null || (Number.isInteger(value) && (value as number) >= 1)
      ? null
      : `${key} must be null or a whole number of at least 1, found ${shown(value)}`;
  if (typeof fallback === "number") {
    const minimum = ZERO_ALLOWED.has(key) ? 0 : 1;
    return Number.isInteger(value) && (value as number) >= minimum
      ? null
      : `${key} must be a whole number of at least ${minimum}, found ${shown(value)}`;
  }
  if (Array.isArray(fallback))
    return Array.isArray(value) &&
      value.every((item) => typeof item === "string")
      ? null
      : `${key} must be a list of names, found ${shown(value)}`;
  return typeof value === typeof fallback
    ? null
    : `${key} must be a ${typeof fallback}, found ${shown(value)}`;
};

/**
 * Checks every setting, limit, column, key and remembered list against the type and range of its default.
 * @param config the merged configuration
 * @param defaults the shipped defaults
 * @returns the configuration with every unusable value replaced by its default, and one sentence per replaced value
 */
export const checkConfig = (
  config: Config,
  defaults: Config = loadDefaults(),
): { config: Config; problems: string[] } => {
  const checked = structuredClone(config);
  const problems: string[] = [];
  for (const section of CHECKED_SECTIONS) {
    const values = checked[section] as Record<string, unknown>;
    for (const [name, fallback] of Object.entries(defaults[section])) {
      const problem = problemOf(
        `${section}.${name}`,
        values[name],
        fallback,
        checked,
      );
      if (!problem) continue;
      problems.push(problem);
      values[name] = structuredClone(fallback);
    }
  }
  return { config: checked, problems };
};

/** Problems found by the last `loadConfig`: an unreadable file, or values replaced by their defaults. */
let lastProblems: string[] = [];

/** @returns what the last load found wrong with the user file; empty when nothing */
export const configProblems = () => lastProblems;

/** @returns the defaults with the user's changes laid over them, every unusable value replaced by its default */
export const loadConfig = (): Config => {
  const defaults = loadDefaults();
  let stored: Record<string, unknown> = {};
  const problems: string[] = [];
  try {
    stored = readUserFile().stored;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(error.message);
  }
  const checked = checkConfig(overlay(defaults, stored), defaults);
  lastProblems = [...problems, ...checked.problems];
  return checked.config;
};

/**
 * Edits `text` so the object it holds becomes `wanted`, touching only values that differ, so comments elsewhere stay.
 * @param text the file's text
 * @param path keys down to the value being compared
 * @param current what the text holds at `path`
 * @param wanted what it should hold there; `undefined` removes it
 * @returns the edited text
 */
const edit = (
  text: string,
  path: string[],
  current: unknown,
  wanted: unknown,
): string => {
  if (path.length && JSON.stringify(current) === JSON.stringify(wanted))
    return text;
  if (isObject(current) && isObject(wanted)) {
    for (const key of new Set([
      ...Object.keys(current),
      ...Object.keys(wanted),
    ]))
      text = edit(text, [...path, key], current[key], wanted[key]);
    return text;
  }
  return applyEdits(text, modify(text, path, wanted, FORMATTING));
};

/** Replaces a file in one rename, so a reader never sees it half written. */
const writeAtomically = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
};

/**
 * Stores a configuration: the user file ends up holding only the values that differ from the defaults; values that
 * did not change keep their place and the comments around them.
 * @param config the whole configuration
 * @throws ConfigError when the user file cannot be read or parsed; it is then left as it is
 */
export const saveConfig = (config: Config) => {
  const { text, stored } = readUserFile();
  const wanted = (difference(config, loadDefaults()) ?? {}) as Record<
    string,
    unknown
  >;
  const edited = edit(text.trim() ? text : "{}\n", [], stored, wanted);
  if (edited !== text)
    writeAtomically(
      userSettings(),
      edited.endsWith("\n") ? edited : `${edited}\n`,
    );
};

/**
 * Puts every setting back to its default; the remembered state is kept.
 * @returns the configuration after the reset
 * @throws ConfigError as `saveConfig` does
 */
export const resetConfig = (): Config => {
  saveConfig({ ...loadDefaults(), state: loadConfig().state });
  return loadConfig();
};

/** @returns the remembered sessions */
export const loadState = (): State => loadConfig().state;

/** @returns where the user settings file lives */
export const userSettingsPath = userSettings;

/**
 * @param state what to remember; settings in the file stay as they are
 * @throws ConfigError as `saveConfig` does
 */
export const saveState = (state: State) =>
  saveConfig({ ...loadConfig(), state });
