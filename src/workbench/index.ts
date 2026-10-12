/**
 * Everything the screen shows, and every action on it, outside React: the
 * open folder and its explorer, the tabs with their documents, which part has
 * the keyboard, the find widget, Quick Open, dialogs, context menus, the
 * settings page and the toolbar message. The screen subscribes and redraws on
 * every change; keys and mouse gestures arrive here as method calls.
 */
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { FSWatcher } from "node:fs";
import {
  loadConfig,
  loadDefaults,
  saveConfig,
  saveState,
  ConfigError,
  userSettingsPath,
  type Config,
} from "@/config";
import {
  cellOf,
  columnAt,
  Document,
  type FindOptions,
  type Match,
  type Position,
} from "@/buffer";
import { copyToClipboard, readClipboard } from "@/clipboard";
import { editField, field, type Field } from "@/field";
import {
  createFile,
  createFolder,
  deleteEntry,
  FileTree,
  fuzzyMatch,
  modifiedTime,
  nameProblem,
  readText,
  renameEntry,
  walkFiles,
  watchFolder,
  writeText,
  type Row,
} from "@/files";
import { DocumentHighlight, SyntaxHighlighter } from "@/highlight";
import { formatText } from "@/format";
import {
  replaceInFile,
  searchFolder,
  searchPattern,
  type FileResult,
  type SearchMatch,
} from "@/search";
import { readGitStatus, type GitStatus } from "@/git";
import { Icons } from "@/icons";
import { bindingOf, type KeyEvent } from "@/keys";
import { commentOf, languageOf } from "@/languages";
import {
  parseValue,
  pageRows,
  SETTINGS,
  valueAt,
  withValue,
  type PageRow,
  type SettingSpec,
} from "@/settings";

/** Which part of the screen has the keyboard. */
export type Focus = "editor" | "explorer" | "settings" | "search";

/** An editor tab. */
export interface Tab {
  id: number;
  kind: "file" | "settings";
  /** Absolute path; `null` for an untitled file and the settings page. */
  path: string | null;
  title: string;
  document: Document | null;
  highlight: DocumentHighlight | null;
  language: string | null;
  scrollTop: number;
  scrollLeft: number;
  /** Why the file is not shown as text (binary, too large, unreadable). */
  notice: string | null;
  /** A format before saving is running. */
  formatting?: boolean;
  /** Modification time when last read or written, to tell changes made elsewhere. */
  modified: number;
}

/** The find widget. */
export interface FindState {
  query: Field;
  replacement: Field;
  replacing: boolean;
  /** Which of its fields has the keyboard; `null` when the editor has it and the widget only stays open. */
  field: "query" | "replacement" | null;
  options: FindOptions;
  matches: Match[];
  current: number;
}

/** One Quick Open entry. */
export interface PaletteItem {
  label: string;
  detail?: string;
  /** Offsets in `label` the query matched, drawn in the accent. */
  positions?: number[];
  run: () => void;
}

/** Quick Open. */
export interface PaletteState {
  field: Field;
  items: PaletteItem[];
  cursor: number;
  placeholder: string;
}

/** A dialog button; returning a string keeps the dialog open with that error. */
export interface DialogButton {
  label: string;
  run: (value: string) => string | void;
  primary?: boolean;
}

/** A modal dialog, as VS Code's: a message, an optional input, buttons. */
export interface DialogState {
  title: string;
  message?: string;
  input?: Field;
  buttons: DialogButton[];
  /** The focused button; -1 is the input. */
  focus: number;
  error?: string;
  /** What Esc does; closing is enough when absent. */
  cancel?: () => void;
}

/** One context menu entry. */
export interface MenuItem {
  label: string;
  key?: string;
  run: () => void;
  separator?: boolean;
}

/** An open context menu, at the cell it was opened from. */
export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  cursor: number;
}

/** The settings page's own state. */
export interface SettingsView {
  search: Field;
  category: string | null;
  /** Index into the setting rows of the page. */
  cursor: number;
  top: number;
  /** The setting whose field is being typed in, and its text. */
  editing: { key: string; field: Field } | null;
  /** An open dropdown: the setting and the highlighted choice. */
  dropdown: { key: string; cursor: number } | null;
  error: string | null;
  /** The search field has the keyboard rather than the list. */
  searching: boolean;
}

/** The Search view in the side bar, as VS Code's. */
export interface SearchView {
  query: Field;
  replacement: Field;
  include: Field;
  exclude: Field;
  replacing: boolean;
  /** The include and exclude fields are shown. */
  details: boolean;
  options: FindOptions;
  /** Which field has the keyboard; `null` when the results do. */
  field: "query" | "replacement" | "include" | "exclude" | null;
  results: FileResult[];
  collapsed: Set<string>;
  cursor: number;
  top: number;
  running: boolean;
  error: string | null;
}

/** One row of the search results: a file, or one of its matches. */
export type SearchRow =
  | { kind: "file"; result: FileResult }
  | { kind: "match"; result: FileResult; match: SearchMatch };

/** A message at the toolbar's right end. */
export interface Status {
  text: string;
  error: boolean;
}

/** A command, for key bindings, the toolbar and Quick Open's `>` mode. */
interface Command {
  action: keyof Config["keys"] | string;
  label: string;
  run: () => void;
}

let nextTabId = 1;

/** How often git's status is read again, for commits and staging made elsewhere (the watcher skips `.git`). */
const GIT_POLL_MS = 3000;

/** The most matches the Search view collects, as VS Code's `search.maxResults`. */
const SEARCH_MAX_MATCHES = 20000;

/** Cells line numbers always get, so the code does not shift as a file grows past 9 or 99 lines, as in VS Code. */
const MIN_NUMBER_CELLS = 3;

const relativeTo = (root: string, path: string) =>
  relative(root, path) || basename(path);

/** The editor's state and actions. */
export class Workbench {
  config: Config;
  tree: FileTree;
  tabs: Tab[] = [];
  active = -1;
  focus: Focus = "editor";
  explorerCursor = 0;
  explorerTop = 0;
  find: FindState | null = null;
  palette: PaletteState | null = null;
  dialog: DialogState | null = null;
  menu: MenuState | null = null;
  settingsView: SettingsView = {
    search: field(),
    category: null,
    cursor: 0,
    top: 0,
    editing: null,
    dropdown: null,
    error: null,
    searching: false,
  };
  status: Status | null = null;
  /** Which view the side bar shows. */
  side: "explorer" | "search" = "explorer";
  search: SearchView = {
    query: field(),
    replacement: field(),
    include: field(),
    exclude: field(),
    replacing: false,
    details: false,
    options: { caseSensitive: false, regex: false, wholeWord: false },
    field: "query",
    results: [],
    collapsed: new Set(),
    cursor: 0,
    top: 0,
    running: false,
    error: null,
  };
  private searchAbort: AbortController | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  update: string | null = null;
  /** Git's decorations for the explorer; `null` outside a repository. */
  git: GitStatus | null = null;
  private gitReading = false;
  private gitTimer: ReturnType<typeof setInterval> | null = null;
  private gitAgain = false;
  /** Counts changes, for the screen's subscription. */
  changes = 0;
  /** Restarts codeee in place after an update; set by the entry point. */
  restart: () => void = () => undefined;
  /** @returns where the user settings file lives */
  userSettingsPath = userSettingsPath;
  /** Rows and cells the editor area has, set by the screen on every draw. */
  view = { rows: 20, columns: 80 };
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private clipboard: { text: string; wholeLine: boolean } | null = null;
  private files: string[] | null = null;
  private watcher: FSWatcher | null = null;
  private untitled = 0;
  private redrawQueued = false;

  /**
   * @param root the opened folder
   * @param highlighter the shared syntax highlighter
   * @param icons file icons
   * @param onQuit leaves codeee
   * @param onConfig the configuration changed (theme, icons): the screen rebuilds them
   */
  constructor(
    readonly root: string,
    public highlighter: SyntaxHighlighter,
    public icons: Icons,
    private onQuit: () => void,
    private onConfig: (config: Config) => void,
  ) {
    this.config = loadConfig();
    this.tree = new FileTree(root, this.config.settings.exclude);
    this.refreshGit();
    this.gitTimer = setInterval(() => this.refreshGit(), GIT_POLL_MS);
    this.watcher = watchFolder(
      root,
      this.config.settings.exclude,
      this.config.limits.watchDebounceMs,
      (paths) => this.changedOnDisk(paths),
    );
    const session = this.config.state.sessions[root];
    for (const path of session?.open ?? [])
      if (modifiedTime(path)) this.open(path, { quiet: true });
    const active = session?.active
      ? this.tabs.findIndex((tab) => tab.path === session.active)
      : -1;
    if (active >= 0) this.active = active;
    if (!this.tabs.length) this.focus = "explorer";
  }

  /** Reads git's status again in the background; a request during a read runs once more after it. */
  refreshGit() {
    if (this.gitReading) {
      this.gitAgain = true;
      return;
    }
    this.gitReading = true;
    void readGitStatus(this.root).then((status) => {
      this.git = status;
      this.gitReading = false;
      this.changed();
      if (this.gitAgain) {
        this.gitAgain = false;
        this.refreshGit();
      }
    });
  }

  /** @param listener called after every change; returns the function that stops it */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Tells the screen to redraw, once per tick however many changes happen in it. */
  changed() {
    this.changes++;
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    queueMicrotask(() => {
      this.redrawQueued = false;
      for (const listener of this.listeners) listener();
    });
  }

  /** @returns the tab on screen, if any */
  get tab(): Tab | null {
    return this.tabs[this.active] ?? null;
  }

  /**
   * Shows a message at the toolbar's right end.
   * @param text the message
   * @param error an error stays longer and shows in the danger colour
   */
  say(text: string, error = false) {
    this.status = { text, error };
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(
      () => {
        this.status = null;
        this.changed();
      },
      error ? this.config.limits.errorStatusMs : this.config.limits.statusMs,
    );
    this.changed();
  }

  // ── files and tabs ────────────────────────────────────────────────────

  /**
   * Opens a file in a tab, or shows its tab when it is open already.
   * @param path the file
   * @param options.line and options.column put the cursor there (0-based); otherwise the last position remembered
   * @param options.quiet open without taking the keyboard from the explorer
   */
  open(
    path: string,
    options: { line?: number; column?: number; quiet?: boolean } = {},
  ) {
    const existing = this.tabs.findIndex((tab) => tab.path === path);
    if (existing >= 0) {
      this.active = existing;
    } else {
      const contents = readText(path, this.config.limits.maxFileMegabytes);
      const notice =
        contents.kind === "binary"
          ? "The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding."
          : contents.kind === "large"
            ? `The file is not displayed in the text editor because it is very large (${contents.megabytes} MB).`
            : contents.kind === "error"
              ? `The editor could not be opened due to an unexpected error: ${contents.message}`
              : null;
      const tab = this.createTab(
        path,
        basename(path),
        contents.kind === "text" ? contents.text : null,
        notice,
      );
      const remembered = this.config.state.positions[path];
      if (tab.document && remembered)
        tab.document.setCursor({ line: remembered[0], column: remembered[1] });
      const after = this.tabs.length ? this.active + 1 : 0;
      this.tabs.splice(after, 0, tab);
      this.active = after;
      this.saveSession();
    }
    const tab = this.tabs[this.active];
    if (tab.document && options.line !== undefined)
      tab.document.setCursor({
        line: options.line,
        column: options.column ?? 0,
      });
    if (!options.quiet) this.focus = "editor";
    this.tree.reveal(path);
    this.revealInExplorer(path);
    this.reveal(true);
    this.changed();
  }

  private createTab(
    path: string | null,
    title: string,
    text: string | null,
    notice: string | null,
  ): Tab {
    const { settings, limits } = this.config;
    const document =
      text === null
        ? null
        : new Document(
            text,
            { useTabs: !settings.insertSpaces, size: settings.tabSize },
            this.editOptions(),
            settings.detectIndentation,
          );
    const language =
      path && document ? languageOf(path, document.lines[0]) : null;
    const tab: Tab = {
      id: nextTabId++,
      kind: "file",
      path,
      title,
      document,
      language,
      highlight: null,
      scrollTop: 0,
      scrollLeft: 0,
      notice,
      modified: path ? modifiedTime(path) : 0,
    };
    if (document)
      tab.highlight = new DocumentHighlight(
        document,
        language,
        this.highlighter,
        limits.highlightChunkLines,
        limits.highlightMaxLines,
        () => this.changed(),
      );
    return tab;
  }

  private editOptions() {
    const { settings, limits } = this.config;
    return {
      autoIndent: settings.autoIndent,
      autoClosingBrackets: settings.autoClosingBrackets,
      typingGroupMs: limits.typingGroupMs,
      undoSteps: limits.undoSteps,
    };
  }

  /** Opens a new untitled file. */
  newFile() {
    this.untitled++;
    const tab = this.createTab(null, `Untitled-${this.untitled}`, "", null);
    this.tabs.splice(this.active + 1, 0, tab);
    this.active = this.active + 1;
    this.focus = "editor";
    this.changed();
  }

  /** Opens the settings page in a tab, or shows it. */
  openSettings() {
    const existing = this.tabs.findIndex((tab) => tab.kind === "settings");
    if (existing >= 0) this.active = existing;
    else {
      const tab: Tab = {
        id: nextTabId++,
        kind: "settings",
        path: null,
        title: "Settings",
        document: null,
        highlight: null,
        language: null,
        scrollTop: 0,
        scrollLeft: 0,
        notice: null,
        modified: 0,
      };
      this.tabs.splice(this.active + 1, 0, tab);
      this.active = this.active + 1;
    }
    this.focus = "settings";
    this.settingsView.searching = true;
    this.changed();
  }

  /** @param index the tab to show */
  activate(index: number) {
    if (!this.tabs[index]) return;
    this.active = index;
    const tab = this.tabs[index];
    this.focus = tab.kind === "settings" ? "settings" : "editor";
    if (tab.path) this.revealInExplorer(tab.path);
    this.updateMatches();
    this.saveSession();
    this.changed();
  }

  /**
   * Closes a tab, asking first when it has unsaved changes.
   * @param index the tab
   */
  close(index = this.active) {
    const tab = this.tabs[index];
    if (!tab) return;
    if (tab.document?.dirty) {
      return this.ask({
        title: `Do you want to save the changes you made to ${tab.title}?`,
        message: "Your changes will be lost if you don't save them.",
        buttons: [
          {
            label: "Save",
            primary: true,
            run: () => void this.save(index, () => this.close(index)),
          },
          { label: "Don't Save", run: () => this.discard(index) },
          { label: "Cancel", run: () => undefined },
        ],
      });
    }
    this.discard(index);
  }

  private discard(index: number) {
    const [tab] = this.tabs.splice(index, 1);
    tab.highlight?.dispose();
    this.remember(tab);
    if (this.active >= index) this.active = Math.max(0, this.active - 1);
    if (!this.tabs.length) {
      this.active = -1;
      this.focus = "explorer";
    } else
      this.focus =
        this.tabs[this.active].kind === "settings" ? "settings" : "editor";
    this.saveSession();
    this.changed();
  }

  /** Keeps the cursor of a file for next time, as neovim's last-position mark. */
  private remember(tab: Tab) {
    if (!tab.path || !tab.document) return;
    const positions = this.config.state.positions;
    delete positions[tab.path];
    positions[tab.path] = [
      tab.document.cursor.line,
      tab.document.cursor.column,
    ];
    const paths = Object.keys(positions);
    for (const path of paths.slice(
      0,
      Math.max(0, paths.length - this.config.limits.rememberedPositions),
    ))
      delete positions[path];
  }

  /** Stores the open tabs and cursor positions of this folder. */
  saveSession() {
    for (const tab of this.tabs) this.remember(tab);
    const state = this.config.state;
    state.sessions[this.root] = {
      open: this.tabs.flatMap((tab) => (tab.path ? [tab.path] : [])),
      active: this.tab?.path ?? null,
    };
    try {
      saveState(state);
    } catch (error) {
      if (error instanceof ConfigError) this.say(error.message, true);
      else throw error;
    }
  }

  /**
   * Saves a file; an untitled one asks for a path first.
   * @param index the tab
   * @param then runs once it is saved
   */
  save(index = this.active, then?: () => void) {
    const tab = this.tabs[index];
    if (!tab?.document) return;
    if (!tab.path) {
      return this.ask({
        title: "Save As",
        message: `Path of the new file, relative to ${basename(this.root)}`,
        input: field(tab.title === "Untitled" ? "" : tab.title),
        buttons: [
          {
            label: "Save",
            primary: true,
            run: (value) => {
              const path = isAbsolute(value)
                ? value
                : resolve(this.root, value.trim());
              if (!value.trim()) return "A file name must be provided.";
              tab.path = path;
              tab.title = basename(path);
              tab.language = languageOf(path, tab.document!.lines[0]);
              if (tab.highlight) tab.highlight.dispose();
              tab.highlight = new DocumentHighlight(
                tab.document!,
                tab.language,
                this.highlighter,
                this.config.limits.highlightChunkLines,
                this.config.limits.highlightMaxLines,
                () => this.changed(),
              );
              this.save(index, then);
            },
          },
          { label: "Cancel", run: () => undefined },
        ],
      });
    }
    const { settings } = this.config;
    if (settings.formatOnSave && !tab.formatting) {
      tab.formatting = true;
      void this.formatDocument(index).finally(() => {
        this.save(index, then);
        tab.formatting = false;
      });
      return;
    }
    tab.document.beforeSave(
      settings.trimTrailingWhitespace,
      settings.insertFinalNewline,
    );
    try {
      tab.modified = writeText(tab.path, tab.document.text());
      tab.document.markSaved();
      this.refreshGit();
      this.tree.refresh();
      this.files = null;
      if (tab.path === userSettingsPath()) this.reloadConfig();
      this.say(`Saved ${relativeTo(this.root, tab.path)}`);
      this.saveSession();
      then?.();
    } catch (error) {
      this.say(
        `Failed to save '${tab.title}': ${(error as Error).message}`,
        true,
      );
    }
    this.changed();
  }

  /**
   * Formats a file with Prettier, as VS Code's Format Document; one undo step, the cursor stays on its line.
   * @param index the tab
   * @returns once formatted; a failure is shown in the toolbar
   */
  async formatDocument(index = this.active) {
    const tab = this.tabs[index];
    const document = tab?.document;
    if (!tab || !document) return;
    const path = tab.path ?? join(this.root, tab.title);
    const version = document.version;
    try {
      const formatted = await formatText(path, document.text());
      if (document.version !== version) return;
      if (document.setText(formatted)) this.afterEdit();
    } catch (error) {
      this.say(`Format Document: ${(error as Error).message}`, true);
    }
  }

  /** Leaves codeee, asking about unsaved files first. */
  quit() {
    const dirty = this.tabs.filter((tab) => tab.document?.dirty);
    const leave = () => {
      this.saveSession();
      this.watcher?.close();
      if (this.gitTimer) clearInterval(this.gitTimer);
      this.onQuit();
    };
    if (!dirty.length) return leave();
    this.ask({
      title:
        dirty.length === 1
          ? `Do you want to save the changes you made to ${dirty[0].title}?`
          : `Do you want to save the changes to the following ${dirty.length} files?`,
      message:
        dirty.length === 1
          ? "Your changes will be lost if you don't save them."
          : `${dirty.map((tab) => tab.title).join(", ")}\n\nYour changes will be lost if you don't save them.`,
      buttons: [
        {
          label: dirty.length === 1 ? "Save" : "Save All",
          primary: true,
          run: () => {
            const saveNext = () => {
              const index = this.tabs.findIndex((tab) => tab.document?.dirty);
              if (index < 0) return leave();
              this.save(index, saveNext);
            };
            saveNext();
          },
        },
        { label: "Don't Save", run: leave },
        { label: "Cancel", run: () => undefined },
      ],
    });
  }

  /** Re-reads the configuration after the settings file or the settings page changed it. */
  reloadConfig() {
    this.config = loadConfig();
    this.tree.exclude = this.config.settings.exclude;
    this.tree.refresh();
    this.files = null;
    for (const tab of this.tabs)
      if (tab.document) tab.document.options = this.editOptions();
    this.onConfig(this.config);
    this.changed();
  }

  /** Something changed on disk: refreshes the explorer and reloads open files that have no unsaved changes. */
  private changedOnDisk(paths: string[]) {
    this.tree.refresh();
    this.refreshGit();
    this.files = null;
    for (const tab of this.tabs) {
      if (!tab.path || !tab.document || !paths.includes(tab.path)) continue;
      const modified = modifiedTime(tab.path);
      if (!modified || modified === tab.modified) continue;
      if (tab.document.dirty) {
        this.say(`${tab.title} changed on disk; saving overwrites it`, true);
        continue;
      }
      const contents = readText(tab.path, this.config.limits.maxFileMegabytes);
      if (contents.kind === "text" && contents.text !== tab.document.text())
        tab.document.reload(contents.text);
      tab.modified = modified;
    }
    this.clampExplorer();
    this.changed();
  }

  // ── explorer ──────────────────────────────────────────────────────────

  /** @returns the explorer's rows */
  explorerRows(): Row[] {
    return this.tree.rows();
  }

  private clampExplorer() {
    const count = this.explorerRows().length;
    this.explorerCursor = Math.max(0, Math.min(this.explorerCursor, count - 1));
  }

  private revealInExplorer(path: string) {
    const index = this.explorerRows().findIndex((row) => row.path === path);
    if (index >= 0) this.explorerCursor = index;
  }

  /**
   * Acts on an explorer row as a click does: a folder opens or closes, a file opens.
   * @param index the row
   * @param keepFocus leave the keyboard in the explorer
   */
  openRow(index: number, keepFocus = false) {
    const row = this.explorerRows()[index];
    if (!row) return;
    this.explorerCursor = index;
    if (row.folder) {
      this.tree.toggle(row.path);
      this.focus = "explorer";
    } else this.open(row.path, { quiet: keepFocus });
    this.changed();
  }

  /** @returns the folder new entries go in: the selected folder, or the selected file's folder */
  private targetFolder() {
    const row =
      this.focus === "explorer"
        ? this.explorerRows()[this.explorerCursor]
        : null;
    if (!row) return this.tab?.path ? dirname(this.tab.path) : this.root;
    return row.folder ? row.path : dirname(row.path);
  }

  /** Asks for a name and creates a file there, then opens it. */
  newFileInExplorer(folder = this.targetFolder()) {
    this.ask({
      title: "New File",
      message: `In ${relativeTo(this.root, folder) || basename(this.root)}`,
      input: field(),
      buttons: [
        {
          label: "Create",
          primary: true,
          run: (name) => {
            const problem = nameProblem(folder, name);
            if (problem) return problem;
            const path = createFile(folder, name);
            this.tree.expanded.add(folder);
            this.tree.refresh();
            this.files = null;
            this.open(path);
          },
        },
        { label: "Cancel", run: () => undefined },
      ],
    });
  }

  /** Asks for a name and creates a folder there. */
  newFolderInExplorer(folder = this.targetFolder()) {
    this.ask({
      title: "New Folder",
      message: `In ${relativeTo(this.root, folder) || basename(this.root)}`,
      input: field(),
      buttons: [
        {
          label: "Create",
          primary: true,
          run: (name) => {
            const problem = nameProblem(folder, name);
            if (problem) return problem;
            const path = createFolder(folder, name);
            this.tree.expanded.add(folder);
            this.tree.refresh();
            this.revealInExplorer(path);
            this.focus = "explorer";
          },
        },
        { label: "Cancel", run: () => undefined },
      ],
    });
  }

  /** Asks for a new name and renames an entry; open tabs follow it. */
  renameInExplorer(path: string) {
    this.ask({
      title: "Rename",
      message: relativeTo(this.root, path),
      input: field(basename(path)),
      buttons: [
        {
          label: "Rename",
          primary: true,
          run: (name) => {
            if (name.trim() === basename(path)) return;
            const problem = nameProblem(dirname(path), name);
            if (problem) return problem;
            const target = renameEntry(path, name);
            for (const tab of this.tabs)
              if (
                tab.path &&
                (tab.path === path || tab.path.startsWith(`${path}/`))
              ) {
                tab.path = target + tab.path.slice(path.length);
                tab.title = basename(tab.path);
              }
            this.tree.refresh();
            this.files = null;
            this.revealInExplorer(target);
            this.saveSession();
          },
        },
        { label: "Cancel", run: () => undefined },
      ],
    });
  }

  /** Asks, then moves an entry to the Trash; its tabs close. */
  deleteInExplorer(path: string) {
    const folder = this.explorerRows().find((row) => row.path === path)?.folder;
    this.ask({
      title: `Are you sure you want to delete '${basename(path)}'${folder ? " and its contents" : ""}?`,
      message:
        process.platform === "darwin"
          ? "You can restore this file from the Trash."
          : "This action is irreversible!",
      buttons: [
        {
          label: process.platform === "darwin" ? "Move to Trash" : "Delete",
          primary: true,
          run: () => {
            try {
              deleteEntry(path);
            } catch (error) {
              return `Failed to delete: ${(error as Error).message}`;
            }
            for (let index = this.tabs.length - 1; index >= 0; index--) {
              const tabPath = this.tabs[index].path;
              if (
                tabPath &&
                (tabPath === path || tabPath.startsWith(`${path}/`))
              )
                this.discard(index);
            }
            this.tree.refresh();
            this.files = null;
            this.clampExplorer();
          },
        },
        { label: "Cancel", run: () => undefined },
      ],
    });
  }

  /** Opens the explorer's context menu for a row at a screen cell. */
  explorerMenu(index: number, x: number, y: number) {
    const row = this.explorerRows()[index];
    if (row) this.explorerCursor = index;
    const folder = row
      ? row.folder
        ? row.path
        : dirname(row.path)
      : this.root;
    const items: MenuItem[] = [
      { label: "New File...", run: () => this.newFileInExplorer(folder) },
      { label: "New Folder...", run: () => this.newFolderInExplorer(folder) },
    ];
    if (row)
      items.push(
        {
          label: "Copy Path",
          separator: true,
          run: () => void this.copy(row.path),
        },
        {
          label: "Copy Relative Path",
          run: () => void this.copy(relativeTo(this.root, row.path)),
        },
        {
          label: "Rename...",
          key: "F2",
          separator: true,
          run: () => this.renameInExplorer(row.path),
        },
        {
          label: "Delete",
          key: "Delete",
          run: () => this.deleteInExplorer(row.path),
        },
      );
    items.push(
      {
        label: "Refresh Explorer",
        separator: true,
        run: () => {
          this.tree.refresh();
          this.files = null;
        },
      },
      {
        label: "Collapse Folders in Explorer",
        run: () => {
          this.tree.expanded.clear();
          this.explorerCursor = 0;
        },
      },
    );
    this.menu = { x, y, items, cursor: 0 };
    this.changed();
  }

  private explorerKey(key: KeyEvent) {
    const rows = this.explorerRows();
    const row = rows[this.explorerCursor];
    const move = (to: number) => {
      this.explorerCursor = Math.max(0, Math.min(rows.length - 1, to));
    };
    switch (key.name) {
      case "up":
        return move(this.explorerCursor - 1);
      case "down":
        return move(this.explorerCursor + 1);
      case "pageup":
        return move(this.explorerCursor - this.view.rows);
      case "pagedown":
        return move(this.explorerCursor + this.view.rows);
      case "home":
        return move(0);
      case "end":
        return move(rows.length - 1);
      case "left":
        if (row?.folder && row.expanded) return this.tree.toggle(row.path);
        return move(
          rows.findIndex(
            (other) => row && other.folder && other.path === dirname(row.path),
          ),
        );
      case "right":
        if (row?.folder && !row.expanded) return this.tree.toggle(row.path);
        return row?.folder ? move(this.explorerCursor + 1) : undefined;
      case "enter":
        return this.openRow(this.explorerCursor);
      case "text":
        if (key.text === " ") return this.openRow(this.explorerCursor, true);
        break;
      case "f2":
        return row && this.renameInExplorer(row.path);
      case "delete":
        return row && this.deleteInExplorer(row.path);
      case "escape":
        if (this.tab)
          this.focus = this.tab.kind === "settings" ? "settings" : "editor";
        return;
    }
  }

  // ── dialogs and menus ─────────────────────────────────────────────────

  /** Opens a dialog. */
  ask(dialog: Omit<DialogState, "focus">) {
    this.dialog = {
      ...dialog,
      focus: dialog.input
        ? -1
        : Math.max(
            0,
            dialog.buttons.findIndex((button) => button.primary),
          ),
    };
    this.changed();
  }

  /** Presses a dialog button. */
  press(index: number) {
    const dialog = this.dialog;
    if (!dialog) return;
    const button = dialog.buttons[index];
    if (!button) return;
    this.dialog = null;
    const error = button.run(dialog.input?.value ?? "");
    if (typeof error === "string") this.dialog = { ...dialog, error };
    this.changed();
  }

  private dialogKey(key: KeyEvent) {
    const dialog = this.dialog!;
    if (key.name === "escape") {
      this.dialog = null;
      dialog.cancel?.();
      return;
    }
    if (key.name === "enter")
      return this.press(
        dialog.focus >= 0
          ? dialog.focus
          : dialog.buttons.findIndex((button) => button.primary),
      );
    if (key.name === "tab") {
      const first = dialog.input ? -1 : 0;
      const count = dialog.buttons.length - first;
      dialog.focus =
        ((dialog.focus - first + (key.shift ? -1 : 1) + count) % count) + first;
      return;
    }
    if (dialog.focus >= 0 && (key.name === "left" || key.name === "right")) {
      dialog.focus = Math.max(
        0,
        Math.min(
          dialog.buttons.length - 1,
          dialog.focus + (key.name === "left" ? -1 : 1),
        ),
      );
      return;
    }
    if (dialog.input) {
      const next = editField(dialog.input, key);
      if (next) {
        dialog.input = next;
        dialog.focus = -1;
        dialog.error = undefined;
      }
    }
  }

  private menuKey(key: KeyEvent) {
    const menu = this.menu!;
    if (key.name === "escape") this.menu = null;
    else if (key.name === "up")
      menu.cursor = (menu.cursor - 1 + menu.items.length) % menu.items.length;
    else if (key.name === "down")
      menu.cursor = (menu.cursor + 1) % menu.items.length;
    else if (key.name === "enter" || (key.name === "text" && key.text === " "))
      this.chooseMenu(menu.cursor);
  }

  /** Runs a menu entry and closes the menu. */
  chooseMenu(index: number) {
    const item = this.menu?.items[index];
    this.menu = null;
    item?.run();
    this.changed();
  }

  /** Opens the editor's context menu at a screen cell. */
  editorMenu(x: number, y: number) {
    const key = (action: keyof Config["keys"]) => this.config.keys[action];
    this.menu = {
      x,
      y,
      cursor: 0,
      items: [
        {
          label: "Go to Bracket",
          run: () => this.withDocument((document) => document.jumpToBracket()),
        },
        {
          label: "Find",
          key: key("find"),
          separator: true,
          run: () => this.openFind(false),
        },
        {
          label: "Replace",
          key: key("replace"),
          run: () => this.openFind(true),
        },
        {
          label: "Cut",
          key: key("cut"),
          separator: true,
          run: () => this.cut(),
        },
        {
          label: "Copy",
          key: key("copy"),
          run: () => void this.copySelection(),
        },
        { label: "Paste", key: key("paste"), run: () => void this.paste() },
        {
          label: "Toggle Line Comment",
          key: key("comment"),
          separator: true,
          run: () => this.toggleComment(),
        },
        {
          label: "Select All",
          key: key("selectAll"),
          run: () => this.withDocument((document) => document.selectAll()),
        },
      ],
    };
    this.changed();
  }

  // ── clipboard ─────────────────────────────────────────────────────────

  private async copy(text: string, wholeLine = false) {
    this.clipboard = { text, wholeLine };
    try {
      await copyToClipboard(text);
    } catch (error) {
      this.say((error as Error).message, true);
    }
  }

  private async copySelection() {
    const document = this.tab?.document;
    if (!document) return;
    const { text, wholeLine } = document.copyText();
    await this.copy(text, wholeLine);
  }

  private cut() {
    const document = this.tab?.document;
    if (!document) return;
    const { text, wholeLine } = document.cut();
    void this.copy(text, wholeLine);
    this.afterEdit();
  }

  private async paste() {
    const document = this.tab?.document;
    if (!document) return;
    const system = await readClipboard();
    const text = system ?? this.clipboard?.text ?? "";
    if (!text) return;
    document.paste(
      text,
      Boolean(this.clipboard?.wholeLine && this.clipboard.text === text),
    );
    this.afterEdit();
  }

  // ── editor ────────────────────────────────────────────────────────────

  private withDocument(action: (document: Document) => void) {
    const document = this.tab?.document;
    if (!document) return;
    action(document);
    this.afterEdit();
  }

  /** After the text or cursor changed: keeps the cursor in view and the find results current. */
  afterEdit() {
    this.updateMatches(false);
    this.reveal();
    this.changed();
  }

  /** @returns the cells the line numbers take, padding included */
  gutterWidth(tab = this.tab) {
    if (!tab?.document || !this.config.settings.lineNumbers) return 1;
    return (
      1 +
      Math.max(MIN_NUMBER_CELLS, String(tab.document.lines.length).length) +
      this.theme.spacing.gutterPadding
    );
  }

  /** The resolved theme, set by the screen. */
  theme = { spacing: { gutterPadding: 2, scrollMargin: 3 } };

  /**
   * Scrolls the active editor so the cursor is in view, keeping `scrollMargin` lines around it as neovim's scrolloff.
   * @param center put the cursor in the middle when it is out of view, as opening a file at a line does
   */
  reveal(center = false) {
    const tab = this.tab;
    const document = tab?.document;
    if (!tab || !document) return;
    const rows = this.view.rows;
    const margin = Math.min(
      this.theme.spacing.scrollMargin,
      Math.floor((rows - 1) / 2),
    );
    const { line, column } = document.cursor;
    if (center && (line < tab.scrollTop || line >= tab.scrollTop + rows))
      tab.scrollTop = line - Math.floor(rows / 2);
    if (line < tab.scrollTop + margin) tab.scrollTop = line - margin;
    if (line > tab.scrollTop + rows - 1 - margin)
      tab.scrollTop = line - rows + 1 + margin;
    tab.scrollTop = Math.max(
      0,
      Math.min(
        tab.scrollTop,
        Math.max(0, document.lines.length - rows + margin),
      ),
    );
    const columns = this.view.columns - this.gutterWidth(tab);
    const cell = cellOf(
      document.lines[line],
      column,
      document.indentation.size,
    );
    if (cell < tab.scrollLeft) tab.scrollLeft = Math.max(0, cell - 4);
    if (cell >= tab.scrollLeft + columns - 1)
      tab.scrollLeft = cell - columns + 2;
  }

  /**
   * Scrolls the editor by lines or cells, without moving the cursor.
   * @param lines lines down (negative up)
   * @param cells cells right (negative left)
   */
  scroll(lines: number, cells = 0) {
    const tab = this.tab;
    if (!tab?.document) return;
    tab.scrollTop = Math.max(
      0,
      Math.min(tab.scrollTop + lines, tab.document.lines.length - 1),
    );
    tab.scrollLeft = Math.max(0, tab.scrollLeft + cells);
    this.changed();
  }

  /**
   * Turns a cell in the editor area into a text position.
   * @param row row from the editor's top
   * @param cell cell from the editor's left, gutter included
   */
  positionAt(row: number, cell: number): Position | null {
    const tab = this.tab;
    const document = tab?.document;
    if (!tab || !document) return null;
    const line = Math.max(
      0,
      Math.min(document.lines.length - 1, tab.scrollTop + row),
    );
    const column = columnAt(
      document.lines[line],
      Math.max(0, cell - this.gutterWidth(tab) + tab.scrollLeft),
      document.indentation.size,
    );
    return { line, column };
  }

  private toggleComment() {
    this.withDocument((document) => {
      const comment = commentOf(this.tab!.language);
      if (comment) document.toggleComment(comment);
      else this.say("Toggle Line Comment is not available for this language");
    });
  }

  private editorKey(key: KeyEvent) {
    const document = this.tab?.document;
    if (!document) return;
    const select = key.shift;
    const word = key.ctrl || key.alt;
    const page = Math.max(1, this.view.rows - 1);
    switch (key.name) {
      case "left":
        document.left(select, word);
        break;
      case "right":
        document.right(select, word);
        break;
      case "up":
        if (key.ctrl && !key.shift) return this.scroll(-1);
        document.vertical(-1, select);
        break;
      case "down":
        if (key.ctrl && !key.shift) return this.scroll(1);
        document.vertical(1, select);
        break;
      case "pageup":
        document.vertical(-page, select);
        this.tab!.scrollTop = Math.max(0, this.tab!.scrollTop - page);
        break;
      case "pagedown":
        document.vertical(page, select);
        this.tab!.scrollTop = Math.min(
          document.lines.length - 1,
          this.tab!.scrollTop + page,
        );
        break;
      case "home":
        if (key.ctrl) document.top(select);
        else document.home(select);
        break;
      case "end":
        if (key.ctrl) document.bottom(select);
        else document.end(select);
        break;
      case "enter":
        document.newline();
        break;
      case "backspace":
        document.backspace(word);
        break;
      case "delete":
        document.deleteForward(word);
        break;
      case "tab":
        if (key.shift) document.outdent();
        else document.indent();
        break;
      case "escape":
        if (this.find) {
          this.find = null;
          break;
        }
        document.setCursor(document.cursor);
        break;
      case "text":
        document.type(key.text!);
        break;
      case "paste":
        document.paste(key.text!);
        break;
      case "\\":
        if (key.ctrl) document.jumpToBracket();
        break;
      default:
        return;
    }
    this.afterEdit();
  }

  // ── find and replace ──────────────────────────────────────────────────

  /**
   * Opens the find widget with the selection, or the word at the cursor, as the query.
   * @param replacing show the replace field too
   */
  openFind(replacing: boolean) {
    const document = this.tab?.document;
    if (!document) return;
    const selected =
      document.hasSelection && !document.selectedText().includes("\n")
        ? document.selectedText()
        : null;
    const word = document.wordAt(document.cursor);
    const seed =
      selected ??
      (word
        ? document.lines[word[0].line].slice(word[0].column, word[1].column)
        : null);
    const previous = this.find;
    this.find = {
      query: seed ? field(seed) : (previous?.query ?? field()),
      replacement: previous?.replacement ?? field(),
      replacing,
      field: replacing && seed ? "replacement" : "query",
      options: previous?.options ?? {
        caseSensitive: false,
        regex: false,
        wholeWord: false,
      },
      matches: [],
      current: 0,
    };
    this.updateMatches(true);
    this.changed();
  }

  /**
   * Recomputes the matches of the find widget.
   * @param jump select the match at or after the cursor
   */
  updateMatches(jump = false) {
    const find = this.find;
    const document = this.tab?.document;
    if (!find) return;
    if (!document) {
      find.matches = [];
      return;
    }
    find.matches = document.find(find.query.value, find.options);
    const { line, column } = document.range()[0];
    const after = find.matches.findIndex(
      (match) =>
        match.line > line || (match.line === line && match.start >= column),
    );
    find.current = after < 0 ? 0 : after;
    if (jump && find.matches.length) this.selectMatch(find.current);
  }

  private selectMatch(index: number) {
    const find = this.find!;
    const document = this.tab!.document!;
    const match = find.matches[index];
    if (!match) return;
    find.current = index;
    document.select(
      { line: match.line, column: match.start },
      { line: match.line, column: match.end },
    );
    this.reveal(true);
  }

  /**
   * Goes to the next or previous match; with the widget closed, searches for the word at the cursor, as neovim's `*`.
   * @param step 1 forward, -1 back
   */
  findStep(step: 1 | -1) {
    const document = this.tab?.document;
    if (!document) return;
    if (!this.find || !this.find.query.value) {
      this.openFind(false);
      if (this.find) this.find.field = null;
    }
    const find = this.find!;
    if (!find.matches.length) return this.changed();
    const [start, end] = document.range();
    const index =
      step > 0
        ? find.matches.findIndex(
            (match) =>
              match.line > end.line ||
              (match.line === end.line && match.start >= end.column),
          )
        : find.matches.findLastIndex(
            (match) =>
              match.line < start.line ||
              (match.line === start.line && match.end <= start.column),
          );
    this.selectMatch(
      index >= 0 ? index : step > 0 ? 0 : find.matches.length - 1,
    );
    this.changed();
  }

  private pattern() {
    const find = this.find!;
    if (!find.options.regex) return undefined;
    try {
      return new RegExp(
        find.query.value,
        `gu${find.options.caseSensitive ? "" : "i"}`,
      );
    } catch {
      return undefined;
    }
  }

  /** Replaces the current match and moves to the next. */
  replaceOne() {
    const find = this.find;
    const document = this.tab?.document;
    if (!find || !document || !find.matches.length) return;
    const match = find.matches[find.current];
    document.replaceMatches([match], find.replacement.value, this.pattern());
    this.updateMatches();
    const next = find.matches.findIndex(
      (other) =>
        other.line > match.line ||
        (other.line === match.line &&
          other.start >= match.start + find.replacement.value.length),
    );
    if (find.matches.length) this.selectMatch(next >= 0 ? next : 0);
    this.afterEdit();
  }

  /** Replaces every match in one undo step. */
  replaceAll() {
    const find = this.find;
    const document = this.tab?.document;
    if (!find || !document || !find.matches.length) return;
    const count = document.replaceMatches(
      find.matches,
      find.replacement.value,
      this.pattern(),
    );
    this.say(
      `Replaced ${count} occurrence${count === 1 ? "" : "s"} across 1 file with '${find.replacement.value}'`,
    );
    this.afterEdit();
  }

  /** Flips a find option. */
  toggleFindOption(option: keyof FindOptions) {
    if (!this.find) return;
    this.find.options[option] = !this.find.options[option];
    this.updateMatches(true);
    this.changed();
  }

  private findKey(key: KeyEvent) {
    const find = this.find!;
    const binding = bindingOf(key);
    if (key.name === "escape") {
      this.find = null;
      return;
    }
    if (binding === "alt+c") return this.toggleFindOption("caseSensitive");
    if (binding === "alt+w") return this.toggleFindOption("wholeWord");
    if (binding === "alt+r") return this.toggleFindOption("regex");
    if (key.name === "tab") {
      find.field =
        find.replacing && find.field === "query" ? "replacement" : "query";
      return;
    }
    if (key.name === "enter" || key.name === "down" || key.name === "up") {
      if (find.field === "replacement" && key.name === "enter")
        return key.ctrl || key.alt ? this.replaceAll() : this.replaceOne();
      return this.findStep(key.shift || key.name === "up" ? -1 : 1);
    }
    const target = find.field === "replacement" ? "replacement" : "query";
    const next = editField(find[target], key);
    if (!next) return;
    find[target] = next;
    if (target === "query") this.updateMatches(true);
  }

  // ── quick open ────────────────────────────────────────────────────────

  /**
   * Opens Quick Open.
   * @param prefix `""` for files, `:` for a line, `>` for commands
   */
  openPalette(prefix = "") {
    this.palette = {
      field: field(prefix),
      items: [],
      cursor: 0,
      placeholder:
        "Search files by name (append : to go to line or > to run a command)",
    };
    this.filterPalette();
    this.changed();
  }

  private filterPalette() {
    const palette = this.palette!;
    const value = palette.field.value;
    palette.cursor = 0;
    if (value.startsWith(">")) {
      const query = value.slice(1).trim();
      palette.items = this.commands()
        .flatMap((command) => {
          const match = fuzzyMatch(command.label, query);
          const key = (this.config.keys as Record<string, string>)[
            command.action
          ];
          return match
            ? [
                {
                  label: command.label,
                  detail: key,
                  positions: match.positions,
                  run: command.run,
                  score: match.score,
                },
              ]
            : [];
        })
        .sort((a, b) => b.score - a.score);
      return;
    }
    const lineMatch =
      /^:(\d*)(?::(\d*))?$/.exec(value) ??
      /^(.*?):(\d+)(?::(\d+))?$/.exec(value);
    if (value.startsWith(":") && lineMatch) {
      const document = this.tab?.document;
      const line = Number(lineMatch[1]) || 0;
      const column = Number(lineMatch[2]) || 0;
      palette.items = document
        ? [
            {
              label: line
                ? `Go to line ${line}${column ? `, character ${column}` : ""}.`
                : `Current Line: ${document.cursor.line + 1}, Character: ${document.cursor.column + 1}. Type a line number between 1 and ${document.lines.length} to navigate to.`,
              run: () => {
                if (!line) return;
                document.setCursor({
                  line: line - 1,
                  column: Math.max(0, column - 1),
                });
                this.focus = "editor";
                this.reveal(true);
              },
            },
          ]
        : [
            {
              label: "Open a text editor first to go to a line.",
              run: () => undefined,
            },
          ];
      return;
    }
    const [query, lineText, columnText] = /^(.*?)(?::(\d+))?(?::(\d+))?$/
      .exec(value)!
      .slice(1);
    this.files ??= walkFiles(
      this.root,
      [...this.config.settings.exclude, ...this.config.settings.searchExclude],
      this.config.limits.quickOpenFiles,
    );
    const scored = this.files.flatMap((path) => {
      const match = fuzzyMatch(path, query);
      return match ? [{ path, ...match }] : [];
    });
    scored.sort((a, b) => b.score - a.score);
    const recent = new Set(
      this.tabs.flatMap((tab) =>
        tab.path ? [relativeTo(this.root, tab.path)] : [],
      ),
    );
    const ordered = query
      ? scored
      : [
          ...scored.filter((entry) => recent.has(entry.path)),
          ...scored.filter((entry) => !recent.has(entry.path)),
        ];
    palette.items = ordered.slice(0, 200).map((entry) => ({
      label: basename(entry.path),
      detail: dirname(entry.path) === "." ? "" : dirname(entry.path),
      positions: entry.positions
        .filter(
          (position) =>
            position >= entry.path.length - basename(entry.path).length,
        )
        .map(
          (position) =>
            position - (entry.path.length - basename(entry.path).length),
        ),
      run: () =>
        this.open(
          join(this.root, entry.path),
          lineText
            ? {
                line: Number(lineText) - 1,
                column: Math.max(0, Number(columnText ?? 1) - 1),
              }
            : {},
        ),
    }));
  }

  /** Runs a Quick Open entry. */
  choosePalette(index: number) {
    const item = this.palette?.items[index];
    this.palette = null;
    item?.run();
    this.changed();
  }

  private paletteKey(key: KeyEvent) {
    const palette = this.palette!;
    if (key.name === "escape") this.palette = null;
    else if (key.name === "enter") this.choosePalette(palette.cursor);
    else if (key.name === "up")
      palette.cursor = Math.max(0, palette.cursor - 1);
    else if (key.name === "down")
      palette.cursor = Math.min(palette.items.length - 1, palette.cursor + 1);
    else if (key.name === "pageup")
      palette.cursor = Math.max(0, palette.cursor - 10);
    else if (key.name === "pagedown")
      palette.cursor = Math.min(palette.items.length - 1, palette.cursor + 10);
    else {
      const next = editField(palette.field, key);
      if (!next) return;
      palette.field = next;
      this.filterPalette();
    }
  }

  // ── settings page ─────────────────────────────────────────────────────

  /** @returns the settings page's rows for its search and category */
  settingsRows(): PageRow[] {
    return pageRows(this.settingsView.category, this.settingsView.search.value);
  }

  /** @returns the settings on the page, in order */
  settingsSpecs(): SettingSpec[] {
    return this.settingsRows().flatMap((row) =>
      row.kind === "setting" ? [row.spec] : [],
    );
  }

  /**
   * Stores a setting and applies it at once, as VS Code's settings editor does.
   * @param key the dotted key
   * @param value the new value
   */
  setSetting(key: string, value: unknown) {
    try {
      saveConfig(withValue(loadConfig(), key, value));
      this.settingsView.error = null;
    } catch (error) {
      this.settingsView.error = (error as Error).message;
    }
    this.reloadConfig();
  }

  /** Puts a setting back to its default. */
  resetSetting(key: string) {
    this.setSetting(key, valueAt(this.defaults(), key));
  }

  /** @returns the shipped defaults */
  defaults() {
    return loadDefaultsCached();
  }

  /**
   * Acts on a setting's control: flips a checkbox, opens a dropdown, or starts typing in a field.
   * @param key the dotted key
   */
  activateSetting(key: string) {
    const spec = SETTINGS.find((entry) => entry.key === key);
    if (!spec) return;
    const view = this.settingsView;
    view.cursor = this.settingsSpecs().findIndex((entry) => entry.key === key);
    view.searching = false;
    const value = valueAt(this.config, key);
    if (spec.type === "boolean") return this.setSetting(key, !value);
    if (spec.type === "enum") {
      view.dropdown = { key, cursor: 0 };
      this.changed();
      return;
    }
    view.editing = {
      key,
      field: field(Array.isArray(value) ? value.join(", ") : String(value)),
    };
    this.changed();
  }

  /** Commits the setting being typed. */
  commitSetting() {
    const view = this.settingsView;
    if (!view.editing) return;
    const spec = SETTINGS.find((entry) => entry.key === view.editing!.key)!;
    const parsed = parseValue(spec, view.editing.field.value);
    if ("error" in parsed) {
      view.error = parsed.error;
      return this.changed();
    }
    view.editing = null;
    this.setSetting(spec.key, parsed.value);
  }

  private settingsKey(key: KeyEvent) {
    const view = this.settingsView;
    const specs = this.settingsSpecs();
    if (view.dropdown) {
      const spec = SETTINGS.find((entry) => entry.key === view.dropdown!.key)!;
      const choices =
        spec.key === "settings.theme"
          ? ["vscode", "auto", ...Object.keys(this.config.themes)]
          : (spec.choices ?? []).map((choice) => choice.value);
      if (key.name === "escape") view.dropdown = null;
      else if (key.name === "up")
        view.dropdown.cursor = Math.max(0, view.dropdown.cursor - 1);
      else if (key.name === "down")
        view.dropdown.cursor = Math.min(
          choices.length - 1,
          view.dropdown.cursor + 1,
        );
      else if (key.name === "enter") {
        const value = choices[view.dropdown.cursor];
        view.dropdown = null;
        this.setSetting(spec.key, value);
      }
      return;
    }
    if (view.editing) {
      if (key.name === "escape") {
        view.editing = null;
        view.error = null;
      } else if (key.name === "enter") this.commitSetting();
      else {
        const next = editField(view.editing.field, key);
        if (next) view.editing.field = next;
      }
      return;
    }
    if (view.searching) {
      if (key.name === "down" || key.name === "enter" || key.name === "tab") {
        view.searching = false;
        view.cursor = 0;
        return;
      }
      if (key.name === "escape") {
        if (view.search.value) {
          view.search = field();
          view.top = 0;
        }
        return;
      }
      const next = editField(view.search, key);
      if (next) {
        view.search = next;
        view.cursor = 0;
        view.top = 0;
      }
      return;
    }
    switch (key.name) {
      case "up":
        if (view.cursor === 0) view.searching = true;
        else view.cursor--;
        return;
      case "down":
        view.cursor = Math.min(specs.length - 1, view.cursor + 1);
        return;
      case "pageup":
        view.cursor = Math.max(0, view.cursor - 5);
        return;
      case "pagedown":
        view.cursor = Math.min(specs.length - 1, view.cursor + 5);
        return;
      case "home":
        view.cursor = 0;
        return;
      case "end":
        view.cursor = specs.length - 1;
        return;
      case "enter":
        return (
          specs[view.cursor] && this.activateSetting(specs[view.cursor].key)
        );
      case "text":
        if (key.text === " " && specs[view.cursor])
          return this.activateSetting(specs[view.cursor].key);
        if (key.text === "/") {
          view.searching = true;
          return;
        }
        return;
      case "escape":
        view.searching = true;
        return;
    }
  }

  // ── search across the folder ──────────────────────────────────────────

  /**
   * Shows the Search view with the selection, or the word at the cursor, as the query.
   * @param replacing open the replace field too
   */
  openSearch(replacing = false) {
    const view = this.search;
    const document = this.tab?.document;
    const selected =
      document?.hasSelection && !document.selectedText().includes("\n")
        ? document.selectedText()
        : null;
    if (selected) view.query = field(selected, true);
    else view.query = { ...view.query, selected: view.query.value.length > 0 };
    view.replacing = view.replacing || replacing;
    view.field = replacing && view.query.value ? "replacement" : "query";
    this.side = "search";
    this.focus = "search";
    if (!this.config.settings.explorer)
      this.setSetting("settings.explorer", true);
    this.runSearch(0);
    this.changed();
  }

  /**
   * Starts the search again after a short pause, so typing does not search on every key.
   * @param delay milliseconds to wait
   */
  runSearch(delay = 250) {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.searchNow(), delay);
  }

  private async searchNow() {
    const view = this.search;
    this.searchAbort?.abort();
    const abort = new AbortController();
    this.searchAbort = abort;
    const query = {
      query: view.query.value,
      include: view.include.value,
      exclude: view.exclude.value,
      ...view.options,
    };
    view.error = null;
    if (!query.query) {
      view.results = [];
      view.running = false;
      return this.changed();
    }
    view.running = true;
    this.changed();
    try {
      const results = await searchFolder(this.root, query, {
        exclude: [
          ...this.config.settings.exclude,
          ...this.config.settings.searchExclude,
        ],
        maxFiles: this.config.limits.quickOpenFiles,
        maxMatches: SEARCH_MAX_MATCHES,
        maxBytes: this.config.limits.maxFileMegabytes * 1024 * 1024,
        signal: abort.signal,
        onProgress: (partial) => {
          if (abort.signal.aborted) return;
          view.results = partial;
          this.changed();
        },
      });
      if (abort.signal.aborted) return;
      for (const tab of this.tabs) {
        if (!tab.path || !tab.document?.dirty) continue;
        const matches = tab.document.find(query.query, query).map((match) => ({
          ...match,
          text: tab.document!.lines[match.line],
        }));
        const others = results.filter((result) => result.path !== tab.path);
        results.length = 0;
        results.push(
          ...others,
          ...(matches.length ? [{ path: tab.path, matches }] : []),
        );
      }
      results.sort((a, b) => a.path.localeCompare(b.path));
      view.results = results;
      view.cursor = Math.min(
        view.cursor,
        Math.max(0, this.searchRows().length - 1),
      );
    } catch (error) {
      view.error = (error as Error).message;
      view.results = [];
    }
    view.running = false;
    this.changed();
  }

  /** @returns the result rows: each file, then its matches unless it is collapsed */
  searchRows(): SearchRow[] {
    return this.search.results.flatMap((result) => [
      { kind: "file" as const, result },
      ...(this.search.collapsed.has(result.path)
        ? []
        : result.matches.map((match) => ({
            kind: "match" as const,
            result,
            match,
          }))),
    ]);
  }

  /**
   * Acts on a result row: a file folds or unfolds, a match opens with the match selected.
   * @param index the row
   * @param keepFocus leave the keyboard in the results
   */
  openSearchRow(index: number, keepFocus = false) {
    const row = this.searchRows()[index];
    if (!row) return;
    this.search.cursor = index;
    this.search.field = null;
    if (row.kind === "file") {
      if (this.search.collapsed.has(row.result.path))
        this.search.collapsed.delete(row.result.path);
      else this.search.collapsed.add(row.result.path);
      return this.changed();
    }
    this.open(row.result.path, { quiet: keepFocus });
    const document = this.tab?.document;
    if (document) {
      document.select(
        { line: row.match.line, column: row.match.start },
        { line: row.match.line, column: row.match.end },
      );
      this.reveal(true);
    }
    this.focus = keepFocus ? "search" : "editor";
    this.changed();
  }

  /**
   * Replaces matches across files: open files are edited and left unsaved, the others are written.
   * @param results the files and matches to replace; all results when absent
   */
  async replaceInFolder(results = this.search.results) {
    const view = this.search;
    const pattern = view.options.regex
      ? searchPattern({
          query: view.query.value,
          include: "",
          exclude: "",
          ...view.options,
        })
      : null;
    let count = 0;
    for (const result of results) {
      const tab = this.tabs.find(
        (open) => open.path === result.path && open.document,
      );
      if (tab?.document) {
        const matches = tab.document.find(view.query.value, view.options);
        count += tab.document.replaceMatches(
          matches,
          view.replacement.value,
          pattern ?? undefined,
        );
        continue;
      }
      try {
        count += await replaceInFile(result, view.replacement.value, pattern);
      } catch (error) {
        this.say(
          `Failed to replace in ${basename(result.path)}: ${(error as Error).message}`,
          true,
        );
      }
    }
    this.say(
      `Replaced ${count} occurrence${count === 1 ? "" : "s"} across ${results.length} file${results.length === 1 ? "" : "s"} with '${view.replacement.value}'`,
    );
    this.runSearch(0);
    this.refreshGit();
    this.changed();
  }

  /** Asks, as VS Code does, then replaces every result. */
  confirmReplaceAll() {
    const view = this.search;
    const files = view.results.length;
    const count = view.results.reduce(
      (total, result) => total + result.matches.length,
      0,
    );
    if (!count) return;
    this.ask({
      title: "Replace All",
      message: `Replace ${count} occurrence${count === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"} with '${view.replacement.value}'?`,
      buttons: [
        {
          label: "Replace",
          primary: true,
          run: () => void this.replaceInFolder(),
        },
        { label: "Cancel", run: () => undefined },
      ],
    });
  }

  /** Flips a search option and searches again. */
  toggleSearchOption(option: keyof FindOptions) {
    this.search.options[option] = !this.search.options[option];
    this.runSearch(0);
    this.changed();
  }

  private searchKey(key: KeyEvent) {
    const view = this.search;
    const rows = this.searchRows();
    const binding = bindingOf(key);
    if (binding === "alt+c") return this.toggleSearchOption("caseSensitive");
    if (binding === "alt+w") return this.toggleSearchOption("wholeWord");
    if (binding === "alt+r") return this.toggleSearchOption("regex");
    if (view.field) {
      const order = [
        "query",
        ...(view.replacing ? ["replacement"] : []),
        ...(view.details ? ["include", "exclude"] : []),
      ] as const;
      if (key.name === "escape") {
        view.field = null;
        if (this.tab)
          this.focus = this.tab.kind === "settings" ? "settings" : "editor";
        return;
      }
      if (
        key.name === "tab" ||
        (key.name === "down" && view.field !== order.at(-1)) ||
        (key.name === "up" && view.field !== "query")
      ) {
        const index = order.indexOf(view.field as (typeof order)[number]);
        view.field = order[
          (index + (key.shift || key.name === "up" ? -1 : 1) + order.length) %
            order.length
        ] as SearchView["field"];
        return;
      }
      if (
        key.name === "down" ||
        (key.name === "enter" && view.field !== "replacement")
      ) {
        if (key.name === "enter") this.runSearch(0);
        if (rows.length && key.name === "down") {
          view.field = null;
          view.cursor = 0;
        }
        return;
      }
      if (key.name === "enter" && view.field === "replacement")
        return this.confirmReplaceAll();
      const name = view.field;
      const next = editField(view[name], key);
      if (!next) return;
      view[name] = next;
      if (name !== "replacement") this.runSearch();
      return;
    }
    switch (key.name) {
      case "up":
        if (view.cursor === 0) view.field = "query";
        else view.cursor--;
        return;
      case "down":
        view.cursor = Math.min(rows.length - 1, view.cursor + 1);
        return;
      case "pageup":
        view.cursor = Math.max(0, view.cursor - this.view.rows);
        return;
      case "pagedown":
        view.cursor = Math.min(rows.length - 1, view.cursor + this.view.rows);
        return;
      case "enter":
        return this.openSearchRow(view.cursor);
      case "text":
        if (key.text === " ") return this.openSearchRow(view.cursor, true);
        return;
      case "left":
        if (rows[view.cursor]?.kind === "file")
          view.collapsed.add(rows[view.cursor].result.path);
        return;
      case "right":
        if (rows[view.cursor]?.kind === "file")
          view.collapsed.delete(rows[view.cursor].result.path);
        return;
      case "escape":
        if (this.tab)
          this.focus = this.tab.kind === "settings" ? "settings" : "editor";
        return;
    }
  }

  /** Shows the explorer in the side bar. */
  showExplorer() {
    this.side = "explorer";
    this.focus = "explorer";
    if (!this.config.settings.explorer)
      this.setSetting("settings.explorer", true);
    this.changed();
  }

  // ── commands and keys ─────────────────────────────────────────────────

  /** @returns every command, for key bindings, the toolbar and Quick Open's `>` mode */
  commands(): Command[] {
    return [
      { action: "save", label: "File: Save", run: () => this.save() },
      {
        action: "newFile",
        label: "File: New Untitled Text File",
        run: () => this.newFile(),
      },
      { action: "close", label: "View: Close Editor", run: () => this.close() },
      { action: "quit", label: "File: Exit", run: () => this.quit() },
      {
        action: "quickOpen",
        label: "Go to File...",
        run: () => this.openPalette(),
      },
      {
        action: "goToLine",
        label: "Go to Line/Column...",
        run: () => this.openPalette(":"),
      },
      { action: "find", label: "Find", run: () => this.openFind(false) },
      { action: "replace", label: "Replace", run: () => this.openFind(true) },
      { action: "findNext", label: "Find Next", run: () => this.findStep(1) },
      {
        action: "findPrevious",
        label: "Find Previous",
        run: () => this.findStep(-1),
      },
      {
        action: "explorer",
        label: "View: Toggle Primary Side Bar Visibility",
        run: () =>
          this.side === "search"
            ? this.showExplorer()
            : this.setSetting(
                "settings.explorer",
                !this.config.settings.explorer,
              ),
      },
      {
        action: "focusExplorer",
        label: "File: Focus on Files Explorer",
        run: () => this.showExplorer(),
      },
      {
        action: "search",
        label: "Search: Find in Files",
        run: () => this.openSearch(false),
      },
      {
        action: "replaceInFiles",
        label: "Search: Replace in Files",
        run: () => this.openSearch(true),
      },
      {
        action: "settings",
        label: "Preferences: Open Settings (UI)",
        run: () => this.openSettings(),
      },
      {
        action: "openSettingsJson",
        label: "Preferences: Open User Settings (JSON)",
        run: () => this.openSettingsJson(),
      },
      {
        action: "undo",
        label: "Undo",
        run: () => this.withDocument((document) => document.undo()),
      },
      {
        action: "redo",
        label: "Redo",
        run: () => this.withDocument((document) => document.redo()),
      },
      { action: "copy", label: "Copy", run: () => void this.copySelection() },
      { action: "cut", label: "Cut", run: () => this.cut() },
      { action: "paste", label: "Paste", run: () => void this.paste() },
      {
        action: "selectAll",
        label: "Select All",
        run: () => this.withDocument((document) => document.selectAll()),
      },
      {
        action: "selectLine",
        label: "Expand Line Selection",
        run: () => this.withDocument((document) => document.selectLine()),
      },
      {
        action: "deleteLine",
        label: "Delete Line",
        run: () => this.withDocument((document) => document.deleteLines()),
      },
      {
        action: "duplicateLine",
        label: "Copy Line Down",
        run: () => this.withDocument((document) => document.duplicateLines()),
      },
      {
        action: "moveLineUp",
        label: "Move Line Up",
        run: () => this.withDocument((document) => document.moveLines(-1)),
      },
      {
        action: "moveLineDown",
        label: "Move Line Down",
        run: () => this.withDocument((document) => document.moveLines(1)),
      },
      {
        action: "format",
        label: "Format Document",
        run: () => void this.formatDocument(),
      },
      {
        action: "comment",
        label: "Toggle Line Comment",
        run: () => this.toggleComment(),
      },
      {
        action: "jumpToBracket",
        label: "Go to Bracket",
        run: () => this.withDocument((document) => document.jumpToBracket()),
      },
      {
        action: "nextTab",
        label: "View: Open Next Editor",
        run: () =>
          this.activate((this.active + 1) % Math.max(1, this.tabs.length)),
      },
      {
        action: "previousTab",
        label: "View: Open Previous Editor",
        run: () =>
          this.activate(
            (this.active - 1 + this.tabs.length) %
              Math.max(1, this.tabs.length),
          ),
      },
      {
        action: "newFileInExplorer",
        label: "File: New File...",
        run: () => this.newFileInExplorer(),
      },
      {
        action: "newFolder",
        label: "File: New Folder...",
        run: () => this.newFolderInExplorer(),
      },
      {
        action: "revealActive",
        label: "File: Reveal Active File in Explorer View",
        run: () => {
          if (!this.tab?.path) return;
          this.tree.reveal(this.tab.path);
          this.revealInExplorer(this.tab.path);
          this.focus = "explorer";
        },
      },
    ];
  }

  /** Opens the user settings file in a tab, creating it when absent. */
  openSettingsJson() {
    const path = userSettingsPath();
    if (!modifiedTime(path)) writeText(path, "{\n}\n");
    this.open(path);
  }

  /**
   * Handles one key: overlays first (dialog, menu, Quick Open), then key bindings, then the focused part.
   * @param key the key
   */
  key(key: KeyEvent) {
    if (this.dialog) this.dialogKey(key);
    else if (this.menu) this.menuKey(key);
    else if (this.palette) this.paletteKey(key);
    else {
      const binding = bindingOf(key);
      const action = Object.entries(this.config.keys).find(
        ([, bound]) => bound === binding,
      )?.[0];
      const command =
        action && this.commands().find((entry) => entry.action === action);
      const typing =
        (this.find?.field && this.focus === "editor") ||
        (this.focus === "search" && this.search.field) ||
        (this.focus === "settings" &&
          (this.settingsView.searching || this.settingsView.editing));
      const fieldKeys = ["copy", "cut", "paste", "selectAll", "undo", "redo"];
      if (command && !(typing && fieldKeys.includes(action))) command.run();
      else if (this.find?.field && this.focus === "editor") this.findKey(key);
      else if (this.focus === "explorer") this.explorerKey(key);
      else if (this.focus === "search") this.searchKey(key);
      else if (this.focus === "settings") this.settingsKey(key);
      else if (this.tab?.document) this.editorKey(key);
      else if (key.name === "escape" || key.name === "tab")
        this.focus = "explorer";
    }
    this.changed();
  }
}

let defaultsCache: Config | null = null;

/** @returns the shipped defaults, read once */
const loadDefaultsCached = (): Config => (defaultsCache ??= loadDefaults());
