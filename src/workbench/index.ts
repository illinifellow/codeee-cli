/**
 * Everything the screen shows, and every action on it, outside React: the
 * open folder and its explorer, the tabs with their documents, which part has
 * the keyboard, the find widget, Quick Open, dialogs, context menus, the
 * settings page and the toolbar message. The screen subscribes and redraws on
 * every change; keys and mouse gestures arrive here as method calls.
 */
import { spawn } from "node:child_process";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  cpSync,
  existsSync,
  renameSync,
  statSync,
  type FSWatcher,
} from "node:fs";
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
  indentOf,
  transformLines,
  type FindOptions,
  type Match,
  type Position,
} from "@/buffer";
import { copyToClipboard, readClipboard } from "@/clipboard";
import { editField, field, type Field } from "@/field";
import {
  createFile,
  expandPath,
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
import { expandEmmet } from "@/emmet";
import { foldEnd, foldsHiding, visibleLines } from "@/folding";
import { readBackups, removeBackup, writeBackup } from "@/backup";
import { formatText } from "@/format";
import { lintText, type Diagnostic } from "@/lint";
import { expandSnippet, findSnippet, loadSnippets } from "@/snippets";
import { fileSymbols, type FileSymbol } from "@/symbols";
import {
  replaceInFile,
  searchFolder,
  searchPattern,
  type FileResult,
  type SearchMatch,
} from "@/search";
import {
  blameLine,
  diffLines,
  inlineDiff,
  type DiffRow,
  readGitStatus,
  timeAgo,
  type GitStatus,
  type LineChange,
} from "@/git";
import { Icons } from "@/icons";
import { bindingOf, optionChord, type KeyEvent } from "@/keys";
import { allLanguages, commentOf, languageOf } from "@/languages";
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
  kind: "file" | "settings" | "preview" | "diff";
  /** The rows of a diff tab. */
  diff?: DiffRow[];
  /** The Markdown file a preview shows. */
  source?: Tab;
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
  /** Opened by a single click in the explorer: the next such click replaces it; an edit or a double click keeps it. */
  preview?: boolean;
  /** The tab stops of the snippet being filled in; Tab goes to the next one, as in VS Code. */
  snippet?: {
    stops: { line: number; column: number; length: number }[];
    index: number;
    lengths: Map<number, number>;
  };
  /** A format before saving is running. */
  formatting?: boolean;
  /** The line and first cell each editor row showed at the last draw, for clicks under word wrap. */
  drawnRows?: { line: number; left: number }[];
  /** Lines whose blocks are folded. */
  folds?: Set<number>;
  /** How lines differ from the last commit, for the gutter. */
  changes?: Map<number, LineChange>;
  /** ESLint's problems for the text as it is now. */
  diagnostics?: Diagnostic[];
  /** Pending lint and auto save. */
  lintTimer?: ReturnType<typeof setTimeout>;
  saveTimer?: ReturnType<typeof setTimeout>;
  backupTimer?: ReturnType<typeof setTimeout>;
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
  /** Find in Selection: matches only inside this range. */
  scope?: [Position, Position];
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

/** Shows a file in the Finder, or the platform's file manager. */
const revealInFinder = (path: string) => {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", ["-R", path]]
      : process.platform === "win32"
        ? ["explorer", [`/select,${path}`]]
        : ["xdg-open", [dirname(path)]];
  spawn(command, args, { detached: true, stdio: "ignore" })
    .on("error", () => undefined)
    .unref();
};

/** How often git's status is read again, for commits and staging made elsewhere (the watcher skips `.git`). */
const GIT_POLL_MS = 3000;

/** A cursor move farther than this many lines counts as a jump for Go Back. */
const NAVIGATION_LINES = 10;

/** How long after the last edit a file's unsaved text is backed up. */
const BACKUP_DELAY_MS = 1000;

/** Letters typed in the explorer within this many milliseconds form one name to jump to. */
const TYPE_TO_FIND_MS = 800;

/** How long the cursor rests on a line before its blame is read, as GitLens waits. */
const BLAME_DELAY_MS = 250;

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
  /** Editor groups side by side, each with its tabs and its active tab, as VS Code's split editors. */
  groups: { tabs: Tab[]; active: number }[] = [{ tabs: [], active: -1 }];
  /** The group with the keyboard. */
  group = 0;
  /** The screen cells each group spans, set by the screen, for dropping dragged tabs. */
  groupBounds: { left: number; right: number; top: number; bottom: number }[] =
    [];
  /** Zen Mode hides the explorer, the toolbar and the breadcrumbs. */
  zen = false;
  /** Groups side by side, or stacked, as View: Toggle Vertical/Horizontal Editor Layout. */
  layout: "horizontal" | "vertical" = "horizontal";

  /** @returns the tabs of the active group */
  get tabs() {
    return this.groups[this.group].tabs;
  }

  set tabs(tabs: Tab[]) {
    this.groups[this.group].tabs = tabs;
  }

  /** @returns the index of the active group's shown tab */
  get active() {
    return this.groups[this.group].active;
  }

  set active(index: number) {
    this.groups[this.group].active = index;
  }

  /** @returns the tabs of every group */
  allTabs() {
    return this.groups.flatMap((group) => group.tabs);
  }

  /**
   * Gives the keyboard to an editor group.
   * @param group the group's index
   */
  focusGroup(group: number) {
    if (!this.groups[group] || group === this.group) return;
    this.group = group;
    this.focus = this.tab?.kind === "settings" ? "settings" : "editor";
    this.updateMatches();
    this.changed();
  }

  /**
   * Opens the active tab in a new group to the right, as View: Split Editor; both show the same document.
   */
  splitEditor() {
    const tab = this.tab;
    if (!tab) return;
    const copy: Tab = {
      ...tab,
      id: nextTabId++,
      preview: false,
      folds: new Set(tab.folds ?? []),
    };
    this.groups.splice(this.group + 1, 0, { tabs: [copy], active: 0 });
    this.group++;
    this.focus = copy.kind === "settings" ? "settings" : "editor";
    this.changed();
  }

  /**
   * Moves a tab to another group, or to a new group at the right edge, as dragging a tab does.
   * @param from the tab's group
   * @param index the tab
   * @param to the target group; the number of groups makes a new one
   */
  moveTab(from: number, index: number, to: number) {
    const source = this.groups[from];
    const [tab] = source?.tabs.splice(index, 1) ?? [];
    if (!tab) return;
    if (to >= this.groups.length) this.groups.push({ tabs: [], active: -1 });
    const target = this.groups[to];
    const existing = target.tabs.findIndex(
      (open) => open.path && open.path === tab.path,
    );
    if (existing >= 0) target.active = existing;
    else {
      target.tabs.splice(target.active + 1, 0, tab);
      target.active = target.tabs.indexOf(tab);
    }
    source.active = Math.min(source.active, source.tabs.length - 1);
    this.group = this.groups.indexOf(target);
    this.dropEmptyGroups();
    this.changed();
  }

  /** Removes groups left without tabs, keeping at least one. */
  private dropEmptyGroups() {
    const current = this.groups[this.group];
    this.groups = this.groups.filter(
      (group) => group.tabs.length || this.groups.length === 1,
    );
    if (!this.groups.length) this.groups = [{ tabs: [], active: -1 }];
    this.group = Math.max(0, this.groups.indexOf(current));
    if (this.group < 0 || !this.groups[this.group])
      this.group = this.groups.length - 1;
  }

  /**
   * Closes, without asking, every tab in every group whose file lies at or under a path, as deleting it does.
   * @param path the deleted path
   */
  private closeUnder(path: string) {
    const current = this.group;
    for (let group = this.groups.length - 1; group >= 0; group--) {
      this.group = group;
      for (let index = this.tabs.length - 1; index >= 0; index--) {
        const tabPath = this.tabs[index].path;
        if (tabPath && (tabPath === path || tabPath.startsWith(`${path}/`)))
          this.discard(index);
      }
    }
    this.group = Math.min(current, this.groups.length - 1);
  }
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
  side: "explorer" | "search" | "outline" = "explorer";
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
  /** Letters typed in the explorer to jump to a name, as VS Code's keyboard navigation. */
  private typed = { text: "", time: 0 };
  /** Files of closed tabs, newest last, for Reopen Closed Editor. */
  private closed: string[] = [];
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  update: string | null = null;
  /** The blame shown at the end of the cursor line, for one file, line and text version. */
  blame: { path: string; line: number; version: number; text: string } | null =
    null;
  private blameTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.tree = new FileTree(
      root,
      this.config.settings.exclude,
      this.config.settings.compactFolders,
    );
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
    for (const backup of readBackups()) {
      if (!backup.path.startsWith(`${root}/`) || !modifiedTime(backup.path))
        continue;
      const before = this.active;
      this.open(backup.path, { quiet: true });
      const restored = this.tab?.document;
      if (restored && restored.text() !== backup.text)
        restored.setText(backup.text);
      this.active = before >= 0 ? before : this.active;
    }
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
    options: {
      line?: number;
      column?: number;
      quiet?: boolean;
      preview?: boolean;
    } = {},
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
      const reuse = options.preview
        ? this.tabs.findIndex((open) => open.preview && !open.document?.dirty)
        : -1;
      tab.preview = options.preview;
      if (reuse >= 0) {
        this.tabs[reuse].highlight?.dispose();
        this.tabs[reuse] = tab;
        this.active = reuse;
      } else {
        const after = this.tabs.length ? this.active + 1 : 0;
        this.tabs.splice(after, 0, tab);
        this.active = after;
      }
      this.saveSession();
    }
    const tab = this.tabs[this.active];
    if (existing >= 0 && !options.preview) tab.preview = false;
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
    if (document) {
      document.onChange((start, removed, inserted) => {
        tab.preview = false;
        if (tab.folds?.size)
          tab.folds = new Set(
            [...tab.folds].flatMap((line) =>
              line < start
                ? [line]
                : line >= start + removed
                  ? [line + inserted - removed]
                  : [],
            ),
          );
        this.lint(tab);
        this.scheduleAutoSave(tab);
        this.scheduleBackup(tab);
      });
      this.lint(tab);
    }
    return tab;
  }

  private editOptions() {
    const { settings, limits } = this.config;
    return {
      autoIndent: settings.autoIndent,
      autoClosingBrackets: settings.autoClosingBrackets,
      autoClosingTags: settings.autoClosingBrackets,
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

  /** Opens Markdown Preview of the active Markdown file beside it, or shows the open one. */
  openPreview() {
    const source = this.tab?.kind === "preview" ? this.tab.source : this.tab;
    if (
      !source?.document ||
      (source.language !== "markdown" && source.language !== "mdx")
    )
      return this.say("Markdown Preview needs a Markdown file in the editor");
    const existing = this.tabs.findIndex(
      (tab) => tab.kind === "preview" && tab.source === source,
    );
    if (existing >= 0) return this.activate(existing);
    const tab: Tab = {
      id: nextTabId++,
      kind: "preview",
      source,
      path: null,
      title: `Preview ${source.title}`,
      document: null,
      highlight: null,
      language: null,
      scrollTop: 0,
      scrollLeft: 0,
      notice: null,
      modified: 0,
    };
    this.tabs.splice(this.active + 1, 0, tab);
    this.active++;
    this.focus = "editor";
    this.changed();
  }

  /** @param index the tab to show */
  activate(index: number) {
    const previous = this.tab;
    if (
      this.config.settings.autoSave === "onFocusChange" &&
      previous?.document?.dirty &&
      previous.path &&
      index !== this.active
    )
      this.save(this.active);
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
    if (
      tab.path &&
      tab.document?.dirty &&
      !this.allTabs().some((other) => other.document === tab.document)
    )
      removeBackup(tab.path);
    if (tab.path) this.closed.push(tab.path);
    tab.highlight?.dispose();
    this.remember(tab);
    if (this.active >= index) this.active = Math.max(0, this.active - 1);
    if (!this.tabs.length && this.groups.length > 1) {
      this.groups.splice(this.group, 1);
      this.group = Math.min(this.group, this.groups.length - 1);
      this.focus = this.tab?.kind === "settings" ? "settings" : "editor";
    } else if (!this.tabs.length) {
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
    for (const tab of this.allTabs()) this.remember(tab);
    const state = this.config.state;
    state.sessions[this.root] = {
      open: [
        ...new Set(
          this.allTabs().flatMap((tab) => (tab.path ? [tab.path] : [])),
        ),
      ],
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
      removeBackup(tab.path);
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
  async formatDocument(index = this.active, selection = false) {
    const tab = this.tabs[index];
    const document = tab?.document;
    if (!tab || !document) return;
    const path = tab.path ?? join(this.root, tab.title);
    const version = document.version;
    const offset = (position: Position) =>
      document.lines
        .slice(0, position.line)
        .reduce((total, line) => total + line.length + document.eol.length, 0) +
      position.column;
    const [start, end] = document.range();
    try {
      const formatted = await formatText(
        path,
        document.text(),
        selection && document.hasSelection
          ? [offset(start), offset(end)]
          : undefined,
      );
      if (document.version !== version) return;
      if (document.setText(formatted)) this.afterEdit();
    } catch (error) {
      this.say(`Format Document: ${(error as Error).message}`, true);
    }
  }

  /** Leaves codeee, asking about unsaved files first. */
  quit() {
    const dirty = [
      ...new Set(
        this.allTabs()
          .filter((tab) => tab.document?.dirty)
          .map((tab) => tab.document),
      ),
    ].map(
      (document) => this.allTabs().find((tab) => tab.document === document)!,
    );
    const leave = () => {
      this.saveSession();
      this.watcher?.close();
      if (this.gitTimer) clearInterval(this.gitTimer);
      this.onQuit();
    };
    if (!dirty.length) return leave();
    if (
      this.config.settings.hotExit === "onExit" &&
      dirty.every((tab) => tab.path)
    ) {
      for (const tab of dirty)
        writeBackup({
          path: tab.path!,
          text: tab.document!.text(),
          modified: tab.modified,
        });
      return leave();
    }
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
              const group = this.groups.findIndex((entry) =>
                entry.tabs.some((tab) => tab.document?.dirty),
              );
              if (group < 0) return leave();
              this.group = group;
              this.save(
                this.tabs.findIndex((tab) => tab.document?.dirty),
                saveNext,
              );
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
    this.tree.compact = this.config.settings.compactFolders;
    this.tree.refresh();
    this.files = null;
    for (const tab of this.allTabs())
      if (tab.document) tab.document.options = this.editOptions();
    this.onConfig(this.config);
    this.changed();
  }

  /** Something changed on disk: refreshes the explorer and reloads open files that have no unsaved changes. */
  private changedOnDisk(paths: string[]) {
    this.tree.refresh();
    this.refreshGit();
    this.files = null;
    for (const tab of this.allTabs()) {
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
  openRow(index: number, keepFocus = false, pin = true) {
    const row = this.explorerRows()[index];
    if (!row) return;
    this.explorerCursor = index;
    if (row.folder) {
      this.tree.toggle(row.path);
      this.focus = "explorer";
    } else this.open(row.path, { quiet: keepFocus, preview: !pin });
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
            for (const tab of this.allTabs())
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

  /** A file or folder copied in the explorer, to paste into another folder. */
  copiedEntry: string | null = null;

  /**
   * Pastes the copied file or folder into a folder, naming the copy `name copy.ext` when the name is taken, as VS Code.
   * @param folder where to
   */
  pasteEntry(folder: string) {
    const source = this.copiedEntry;
    if (!source || !existsSync(source)) return;
    const extension = extname(source);
    const stem = basename(source, extension);
    let target = join(folder, basename(source));
    for (let count = 1; existsSync(target); count++)
      target = join(
        folder,
        `${stem} copy${count > 1 ? ` ${count}` : ""}${extension}`,
      );
    try {
      cpSync(source, target, { recursive: true });
    } catch (error) {
      return this.say(`Failed to paste: ${(error as Error).message}`, true);
    }
    this.tree.expanded.add(folder);
    this.tree.refresh();
    this.files = null;
    this.revealInExplorer(target);
  }

  /** The explorer row a drag is over. */
  dropTarget: string | null = null;

  /**
   * Moves a file or folder into another folder, as a drag in the explorer does; open tabs follow it.
   * @param path what to move
   * @param folder where to
   */
  moveEntry(path: string, folder: string) {
    if (
      dirname(path) === folder ||
      folder === path ||
      folder.startsWith(`${path}/`)
    )
      return;
    const problem = nameProblem(folder, basename(path));
    if (problem) return this.say(problem, true);
    try {
      renameSync(path, join(folder, basename(path)));
    } catch (error) {
      return this.say(
        `Failed to move '${basename(path)}': ${(error as Error).message}`,
        true,
      );
    }
    const target = join(folder, basename(path));
    for (const tab of this.allTabs())
      if (tab.path && (tab.path === path || tab.path.startsWith(`${path}/`)))
        tab.path = target + tab.path.slice(path.length);
    this.tree.expanded.add(folder);
    this.tree.refresh();
    this.files = null;
    this.revealInExplorer(target);
    this.saveSession();
    this.say(
      `Moved ${basename(path)} to ${relativeTo(this.root, folder) || basename(this.root)}`,
    );
  }

  /** Asks, then moves an entry to the Trash; its tabs close. */
  deleteInExplorer(path: string) {
    if (!this.config.settings.confirmDelete) {
      try {
        deleteEntry(path);
      } catch (error) {
        return this.say(`Failed to delete: ${(error as Error).message}`, true);
      }
      this.closeUnder(path);
      this.tree.refresh();
      this.files = null;
      this.clampExplorer();
      return this.changed();
    }
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
            this.closeUnder(path);
            this.tree.refresh();
            this.files = null;
            this.clampExplorer();
          },
        },
        { label: "Cancel", run: () => undefined },
      ],
    });
  }

  /** Puts a cursor on every occurrence of the selection or the word at the cursor, as Change All Occurrences. */
  selectAllOccurrences() {
    this.withDocument((document) => {
      if (!document.addNextOccurrence()) return;
      while (document.extras.length < 10000 && document.addNextOccurrence());
    });
  }

  /**
   * Opens a tab's context menu at a screen cell, as VS Code's tab menu.
   * @param group the tab's group
   * @param index the tab
   */
  tabMenu(group: number, index: number, x: number, y: number) {
    this.focusGroup(group);
    const tab = this.tabs[index];
    if (!tab) return;
    const closeWhere = (keep: (other: Tab, position: number) => boolean) => {
      for (let position = this.tabs.length - 1; position >= 0; position--)
        if (!keep(this.tabs[position], position)) this.close(position);
    };
    this.menu = {
      x,
      y,
      cursor: 0,
      items: [
        {
          label: "Close",
          key: this.config.keys.close,
          run: () => this.close(index),
        },
        {
          label: "Close Others",
          run: () => closeWhere((other) => other === tab),
        },
        {
          label: "Close to the Right",
          run: () => closeWhere((_other, position) => position <= index),
        },
        {
          label: "Close Saved",
          run: () => closeWhere((other) => Boolean(other.document?.dirty)),
        },
        { label: "Close All", run: () => closeWhere(() => false) },
        ...(tab.path
          ? [
              {
                label: "Copy Path",
                separator: true,
                run: () => void this.copy(tab.path!),
              },
              {
                label: "Copy Relative Path",
                run: () => void this.copy(relativeTo(this.root, tab.path!)),
              },
              {
                label: "Reveal in Finder",
                run: () => revealInFinder(tab.path!),
              },
              {
                label: "Reveal in Explorer View",
                run: () =>
                  this.commands()
                    .find((command) => command.action === "revealActive")
                    ?.run(),
              },
            ]
          : []),
        {
          label: "Keep Open",
          separator: true,
          run: () => void (tab.preview = false),
        },
        { label: "Split Right", run: () => this.splitEditor() },
      ],
    };
    this.active = index;
    this.changed();
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
        { label: "Reveal in Finder", run: () => revealInFinder(row.path) },
        ...(row.folder
          ? [
              {
                label: "Find in Folder...",
                run: () => {
                  this.search.include = field(
                    `${relativeTo(this.root, row.path)}/**`,
                  );
                  this.search.details = true;
                  this.openSearch(false);
                },
              },
            ]
          : []),
        {
          label: "Copy",
          separator: true,
          run: () => void (this.copiedEntry = row.path),
        },
        ...(this.copiedEntry
          ? [{ label: "Paste", run: () => this.pasteEntry(folder) }]
          : []),
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
        return row && this.renameInExplorer(row.path);
      case "text": {
        if (key.text === " " && !this.typed.text)
          return this.openRow(this.explorerCursor, !row?.folder, false);
        const now = Date.now();
        this.typed = {
          text:
            (now - this.typed.time < TYPE_TO_FIND_MS ? this.typed.text : "") +
            key.text!.toLowerCase(),
          time: now,
        };
        const order = [...rows.keys()].map(
          (offset) =>
            (this.explorerCursor +
              (this.typed.text.length > 1 ? 0 : 1) +
              offset) %
            rows.length,
        );
        const found = order.find((index) =>
          rows[index].name.toLowerCase().startsWith(this.typed.text),
        );
        if (found !== undefined) move(found);
        return;
      }
      case "f2":
        return row && this.renameInExplorer(row.path);
      case "delete":
      case "backspace":
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
          label: "Go to Definition",
          key: "f12",
          run: () => void this.goToDefinition(),
        },
        {
          label: "Go to Symbol...",
          key: key("goToSymbol"),
          run: () => this.openPalette("@"),
        },
        {
          label: "Rename Symbol",
          key: "f2",
          separator: true,
          run: () => this.renameSymbol(),
        },
        {
          label: "Change All Occurrences",
          run: () => this.selectAllOccurrences(),
        },
        {
          label: "Format Document",
          key: key("format"),
          run: () => void this.formatDocument(),
        },
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

  /**
   * Asks git who last changed the cursor line, after the cursor rests a moment; the answer is drawn at the line's end.
   * Lines with unsaved changes show "You, Uncommitted changes", as GitLens does.
   */
  requestBlame() {
    const tab = this.tab;
    const document = tab?.document;
    if (!tab?.path || !document || !this.config.settings.lineBlame || !this.git)
      return;
    const { line } = document.cursor;
    const { path } = tab;
    const version = document.version;
    if (
      this.blame?.path === path &&
      this.blame.line === line &&
      this.blame.version === version
    )
      return;
    if (this.blameTimer) clearTimeout(this.blameTimer);
    this.blameTimer = setTimeout(async () => {
      const found = document.dirty ? null : await blameLine(path, line);
      const text = document.dirty
        ? "You, Uncommitted changes"
        : !found
          ? ""
          : found.uncommitted
            ? "You, Uncommitted changes"
            : `${found.mine ? "You" : found.author}, ${timeAgo(found.time)} • ${found.summary}`;
      this.blame = { path, line, version, text };
      this.changed();
    }, BLAME_DELAY_MS);
  }

  /**
   * Lints a tab's text with the project's ESLint a moment after the last change; the result is dropped when the text
   * changed meanwhile.
   */
  lint(tab: Tab) {
    const document = tab.document;
    if (!tab.path || !document) return;
    if (tab.lintTimer) clearTimeout(tab.lintTimer);
    tab.lintTimer = setTimeout(async () => {
      const version = document.version;
      const [diagnostics, changes] = await Promise.all([
        this.config.settings.eslint ? lintText(tab.path!, document.text()) : [],
        this.git
          ? diffLines(tab.path!, document.text())
          : new Map<number, LineChange>(),
      ]);
      if (document.version !== version) return;
      tab.diagnostics = diagnostics;
      tab.changes = changes;
      this.changed();
    }, this.config.limits.lintDelayMs);
  }

  private symbolCache = new WeakMap<
    Tab,
    { version: number; symbols: FileSymbol[] }
  >();

  /** @returns the symbols of a tab's file, read once per text version */
  symbolsOf(tab: Tab): FileSymbol[] {
    const document = tab.document;
    if (!document) return [];
    const cached = this.symbolCache.get(tab);
    if (cached?.version === document.version) return cached.symbols;
    const symbols = fileSymbols(document.lines, tab.language);
    this.symbolCache.set(tab, { version: document.version, symbols });
    return symbols;
  }

  /**
   * Goes to where the word at the cursor is declared, as F12 does: a symbol of this file first, then a declaration
   * found across the folder (function, class, interface, type, const, let, var, def).
   */
  async goToDefinition() {
    const tab = this.tab;
    const document = tab?.document;
    const word = document?.wordAt(document.cursor);
    if (!tab || !document || !word) return;
    const name = document.lines[word[0].line].slice(
      word[0].column,
      word[1].column,
    );
    const own = this.symbolsOf(tab).find(
      (symbol) => symbol.name === name && symbol.line !== document.cursor.line,
    );
    if (own) {
      document.setCursor({
        line: own.line,
        column: Math.max(0, document.lines[own.line].indexOf(name)),
      });
      this.reveal(true);
      return this.changed();
    }
    this.say(`Looking for the definition of '${name}'…`);
    const escaped = name.replace(/[$]/g, "\\$");
    const query = `(?:function\\*?|class|interface|type|enum|const|let|var|def|fn|struct)\\s+${escaped}\\b`;
    const results = await searchFolder(
      this.root,
      {
        query,
        include: "",
        exclude: "",
        caseSensitive: true,
        regex: true,
        wholeWord: false,
      },
      {
        exclude: [
          ...this.config.settings.exclude,
          ...this.config.settings.searchExclude,
        ],
        maxFiles: this.config.limits.quickOpenFiles,
        maxMatches: 20,
        maxBytes: this.config.limits.maxFileMegabytes * 1024 * 1024,
      },
    ).catch(() => []);
    const found = results[0];
    if (!found) return this.say(`No definition found for '${name}'`);
    const match = found.matches[0];
    this.open(found.path, {
      line: match.line,
      column: match.text.indexOf(name, match.start),
    });
    this.say(
      results.length > 1 || found.matches.length > 1
        ? `${results.reduce((total, result) => total + result.matches.length, 0)} definitions; showing the first`
        : `Definition of '${name}'`,
    );
  }

  private visibleCache = new WeakMap<Tab, { key: string; lines: number[] }>();

  /** @returns the lines of a tab left on screen by its folds, computed once per text version and fold set */
  visibleOf(tab: Tab): number[] {
    const document = tab.document;
    if (!document) return [];
    const key = `${document.version}:${[...(tab.folds ?? [])].join(",")}`;
    const cached = this.visibleCache.get(tab);
    if (cached?.key === key) return cached.lines;
    const lines = tab.folds?.size
      ? visibleLines(document.lines, tab.folds)
      : document.lines.map((_line, index) => index);
    this.visibleCache.set(tab, { key, lines });
    return lines;
  }

  /**
   * Folds or unfolds the block a line opens; on a line inside a block, the nearest block around it.
   * @param line the line; the cursor's when absent
   */
  toggleFold(line = this.tab?.document?.cursor.line) {
    const tab = this.tab;
    const document = tab?.document;
    if (!tab || !document || line === undefined) return;
    tab.folds ??= new Set();
    if (tab.folds.has(line)) tab.folds.delete(line);
    else {
      let start = line;
      while (start >= 0 && (foldEnd(document.lines, start) ?? -1) < line)
        start--;
      if (start < 0) return this.say("Nothing to fold here");
      tab.folds.add(start);
      if (document.cursor.line > start)
        document.setCursor({ line: start, column: document.cursor.column });
    }
    this.afterEdit();
  }

  /** Folds every block at the outermost foldable levels, or unfolds all. */
  foldAll(fold: boolean) {
    const tab = this.tab;
    const document = tab?.document;
    if (!tab || !document) return;
    tab.folds = new Set();
    if (fold)
      for (let line = 0; line < document.lines.length; line++) {
        const end = foldEnd(document.lines, line);
        if (end === null || line === 0) continue;
        tab.folds.add(line);
        line = end;
      }
    document.setCursor({
      line: Math.min(document.cursor.line, document.lines.length - 1),
      column: 0,
    });
    this.afterEdit();
  }

  /** Renames the word at the cursor everywhere in the file, as F2 does for a symbol, matching whole words and case. */
  renameSymbol() {
    const document = this.tab?.document;
    const word = document?.wordAt(document.cursor);
    if (!document || !word) return this.say("The element can't be renamed.");
    const name = document.lines[word[0].line].slice(
      word[0].column,
      word[1].column,
    );
    this.ask({
      title: `Rename '${name}'`,
      message: "Every whole-word occurrence in this file is renamed.",
      input: field(name, true),
      buttons: [
        {
          label: "Rename",
          primary: true,
          run: (value) => {
            const next = value.trim();
            if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(next))
              return `'${next}' is not a valid name.`;
            const options = {
              caseSensitive: true,
              regex: false,
              wholeWord: true,
            };
            const count = document.replaceMatches(
              document.find(name, options),
              next,
            );
            this.say(
              `Renamed ${count} occurrence${count === 1 ? "" : "s"} of '${name}' to '${next}'`,
            );
            this.afterEdit();
          },
        },
        { label: "Cancel", run: () => undefined },
      ],
    });
  }

  /** Lets the user pick the active file's language mode, as the status bar's language item does. */
  pickLanguage() {
    const tab = this.tab;
    if (!tab?.document) return;
    this.palette = {
      field: field(),
      cursor: 0,
      placeholder: "Select Language Mode",
      items: [],
    };
    this.paletteSource = (query) =>
      allLanguages()
        .flatMap((language) => {
          const match = fuzzyMatch(language.name, query);
          return match
            ? [
                {
                  label: language.name,
                  detail: language.id,
                  positions: match.positions,
                  score: match.score,
                  run: () => {
                    tab.language = language.id;
                    tab.highlight?.dispose();
                    tab.highlight = new DocumentHighlight(
                      tab.document!,
                      language.id,
                      this.highlighter,
                      this.config.limits.highlightChunkLines,
                      this.config.limits.highlightMaxLines,
                      () => this.changed(),
                    );
                  },
                },
              ]
            : [];
        })
        .sort((a, b) => (query ? b.score - a.score : 0));
    this.filterPalette();
    this.changed();
  }

  /** Lets the user pick tabs or spaces and the indent size of the active file. */
  pickIndentation() {
    const document = this.tab?.document;
    if (!document) return;
    this.palette = {
      field: field(),
      cursor: 0,
      placeholder: "Select Indentation",
      items: [],
    };
    this.paletteSource = () =>
      [
        ...[2, 4, 8].map((size) => ({ useTabs: false, size })),
        ...[2, 4, 8].map((size) => ({ useTabs: true, size })),
      ].map((indentation) => ({
        label: indentation.useTabs
          ? `Indent Using Tabs, Tab Size ${indentation.size}`
          : `Indent Using Spaces, ${indentation.size}`,
        run: () => void (document.indentation = indentation),
      }));
    this.filterPalette();
    this.changed();
  }

  /**
   * Opens another folder in place, as VS Code's Open Folder: codeee restarts on it once no file is unsaved.
   * @param value the folder, `~` allowed
   * @returns a sentence saying why it cannot, for the dialog
   */
  switchFolder(value: string) {
    const folder = expandPath(value.trim());
    if (!existsSync(folder) || !statSync(folder).isDirectory())
      return `${folder} is not a folder.`;
    if (this.allTabs().some((tab) => tab.document?.dirty))
      return "Save or close the unsaved files first.";
    const state = this.config.state;
    state.recent = [
      folder,
      ...state.recent.filter((path) => path !== folder),
    ].slice(0, this.config.limits.recentFolders);
    this.saveSession();
    process.env.CODEEE_NEXT_FOLDER = folder;
    this.restart();
  }

  /** Where the cursor was at each jump, for Go Back and Go Forward. */
  private back: { path: string; line: number; column: number }[] = [];
  private forward: { path: string; line: number; column: number }[] = [];
  private lastLocation: { path: string; line: number; column: number } | null =
    null;
  private navigating = false;

  /**
   * Returns to where the cursor was before the last jump, or goes forward again, as VS Code's Go Back and Go Forward.
   * @param step -1 back, 1 forward
   */
  navigate(step: -1 | 1) {
    const [from, to] =
      step < 0 ? [this.back, this.forward] : [this.forward, this.back];
    const target = from.pop();
    if (!target) return;
    if (this.lastLocation) to.push(this.lastLocation);
    this.navigating = true;
    if (target.path)
      this.open(target.path, { line: target.line, column: target.column });
    this.navigating = false;
    this.changed();
  }

  /** Opens the changes of the active file against its last commit in a tab, as VS Code's Open Changes. */
  async openChanges(saved = false) {
    const source = this.tab?.kind === "diff" ? this.tab.source : this.tab;
    if (!source?.path || !source.document)
      return this.say("Open Changes needs a file in a git repository");
    const disk = saved
      ? readText(source.path, this.config.limits.maxFileMegabytes)
      : null;
    const rows = await inlineDiff(
      source.path,
      source.document.text(),
      3,
      disk?.kind === "text" ? disk.text : undefined,
    );
    if (!rows) return this.say(`${source.title} is not tracked by git`);
    const existing = this.tabs.findIndex(
      (tab) => tab.kind === "diff" && tab.source === source,
    );
    if (existing >= 0) {
      this.tabs[existing].diff = rows;
      this.tabs[existing].title = saved
        ? `${source.title} (Saved ↔ Editor)`
        : `${source.title} (Working Tree)`;
      return this.activate(existing);
    }
    const tab: Tab = {
      id: nextTabId++,
      kind: "diff",
      source,
      diff: rows,
      path: null,
      title: saved
        ? `${source.title} (Saved ↔ Editor)`
        : `${source.title} (Working Tree)`,
      document: null,
      highlight: null,
      language: null,
      scrollTop: 0,
      scrollLeft: 0,
      notice: null,
      modified: 0,
    };
    this.tabs.splice(this.active + 1, 0, tab);
    this.active++;
    this.focus = "editor";
    this.changed();
  }

  /** Lists the ESLint problems of every open file in Quick Open, errors first, as VS Code's Problems view. */
  showProblems() {
    const seen = new Set<Document>();
    const entries = this.allTabs().flatMap((tab) => {
      if (!tab.document || !tab.path || seen.has(tab.document)) return [];
      seen.add(tab.document);
      return (tab.diagnostics ?? []).map((problem) => ({ tab, problem }));
    });
    entries.sort((a, b) =>
      a.problem.severity === b.problem.severity
        ? 0
        : a.problem.severity === "error"
          ? -1
          : 1,
    );
    this.palette = {
      field: field(),
      cursor: 0,
      placeholder: entries.length
        ? "Filter problems"
        : "No problems have been detected in the workspace.",
      items: [],
    };
    this.paletteSource = (query) =>
      entries.flatMap(({ tab, problem }) => {
        const label = `${problem.severity === "error" ? "✖" : "⚠"} ${problem.message}`;
        const match = fuzzyMatch(label, query);
        return match
          ? [
              {
                label,
                detail: `${relativeTo(this.root, tab.path!)} ${problem.line + 1}:${problem.start + 1}${problem.rule ? `  ${problem.rule}` : ""}`,
                positions: match.positions,
                run: () =>
                  this.open(tab.path!, {
                    line: problem.line,
                    column: problem.start,
                  }),
              },
            ]
          : [];
      });
    this.filterPalette();
    this.changed();
  }

  /** Opens the most recently closed tab again. */
  reopenClosed() {
    const path = this.closed.pop();
    if (path) this.open(path);
  }

  /** Moves the cursor to the next or previous ESLint problem, wrapping around, and shows its message. */
  stepProblem(step: 1 | -1) {
    const tab = this.tab;
    const document = tab?.document;
    const problems = [...(tab?.diagnostics ?? [])].sort(
      (a, b) => a.line - b.line || a.start - b.start,
    );
    if (!document || !problems.length)
      return this.say("No problems have been detected in the file.");
    const { line, column } = document.cursor;
    const after = (problem: Diagnostic) =>
      problem.line > line || (problem.line === line && problem.start > column);
    const next =
      step > 0
        ? (problems.find(after) ?? problems[0])
        : ([...problems]
            .reverse()
            .find(
              (problem) =>
                !after(problem) &&
                (problem.line < line || problem.start < column),
            ) ?? problems.at(-1)!);
    document.setCursor({ line: next.line, column: next.start });
    this.say(
      `${next.message}${next.rule ? ` eslint(${next.rule})` : ""}`,
      next.severity === "error",
    );
    this.reveal(true);
    this.changed();
  }

  /**
   * Backs up every unsaved file now, before a restart.
   * @returns whether every unsaved file could be kept (untitled files cannot, nor anything with hot exit off)
   */
  backupAll() {
    if (this.config.settings.hotExit === "off")
      return !this.allTabs().some((tab) => tab.document?.dirty);
    for (const tab of this.allTabs())
      if (tab.path && tab.document?.dirty)
        writeBackup({
          path: tab.path,
          text: tab.document.text(),
          modified: tab.modified,
        });
    return !this.allTabs().some((tab) => !tab.path && tab.document?.dirty);
  }

  /** Keeps a changed file's text in a backup a moment after the last edit, for hot exit and crashes. */
  private scheduleBackup(tab: Tab) {
    if (!tab.path || this.config.settings.hotExit === "off") return;
    if (tab.backupTimer) clearTimeout(tab.backupTimer);
    tab.backupTimer = setTimeout(() => {
      if (!tab.path || !tab.document) return;
      if (tab.document.dirty)
        writeBackup({
          path: tab.path,
          text: tab.document.text(),
          modified: tab.modified,
        });
      else removeBackup(tab.path);
    }, BACKUP_DELAY_MS);
  }

  /** Saves a changed file after a pause, when `autoSave` is `afterDelay`, as VS Code's `files.autoSave`. */
  private scheduleAutoSave(tab: Tab) {
    if (this.config.settings.autoSave !== "afterDelay" || !tab.path) return;
    if (tab.saveTimer) clearTimeout(tab.saveTimer);
    tab.saveTimer = setTimeout(() => {
      const index = this.tabs.indexOf(tab);
      if (index >= 0 && tab.document?.dirty) this.save(index);
    }, this.config.limits.autoSaveDelayMs);
  }

  /**
   * Expands the snippet whose prefix is the word before the cursor, as Tab completion does in VS Code.
   * @returns whether a snippet was inserted
   */
  private expandSnippet() {
    const tab = this.tab;
    const document = tab?.document;
    if (
      !tab ||
      !document ||
      document.hasSelection ||
      !this.config.settings.snippets
    )
      return false;
    const { line, column } = document.cursor;
    const word = /[\w$.!-]+$/.exec(document.lines[line].slice(0, column))?.[0];
    if (!word) return false;
    loadSnippets();
    const snippet = findSnippet(tab.language, word);
    if (!snippet) return this.expandAbbreviation();
    const unit = document.indentation.useTabs
      ? "\t"
      : " ".repeat(document.indentation.size);
    const expanded = expandSnippet(snippet.body, {
      fileName: tab.title,
      indent: indentOf(document.lines[line]),
      unit,
    });
    const start = { line, column: column - word.length };
    document.replace(start, document.cursor, expanded.text, "edit");
    const toPosition = (offset: number) => {
      const head = expanded.text.slice(0, offset).split("\n");
      return {
        line: line + head.length - 1,
        column: (head.length === 1 ? start.column : 0) + head.at(-1)!.length,
      };
    };
    const at = toPosition(expanded.cursor);
    document.select(at, {
      line: at.line,
      column: at.column + expanded.selected,
    });
    const stops = expanded.placeholders.map((stop) => ({
      ...toPosition(stop.offset),
      length: stop.length,
    }));
    tab.snippet =
      stops.length > 1
        ? {
            stops,
            index: 0,
            lengths: new Map(
              stops.map((stop) => [
                stop.line,
                document.lines[stop.line].length,
              ]),
            ),
          }
        : undefined;
    return true;
  }

  /**
   * Moves to the next tab stop of the snippet being filled in, selecting its placeholder; the stops after the edited
   * one move with the text typed on their line.
   * @returns whether there was one to go to
   */
  private nextSnippetStop() {
    const tab = this.tab;
    const document = tab?.document;
    const snippet = tab?.snippet;
    if (!tab || !document || !snippet) return false;
    const current = snippet.stops[snippet.index];
    const delta =
      document.lines[current.line].length -
      (snippet.lengths.get(current.line) ?? 0);
    for (const stop of snippet.stops.slice(snippet.index + 1))
      if (stop.line === current.line && stop.column >= current.column)
        stop.column += delta;
    snippet.lengths.set(current.line, document.lines[current.line].length);
    snippet.index++;
    const next = snippet.stops[snippet.index];
    if (!next || next.line >= document.lines.length) {
      tab.snippet = undefined;
      return false;
    }
    document.select(next, {
      line: next.line,
      column: next.column + next.length,
    });
    if (snippet.index === snippet.stops.length - 1) tab.snippet = undefined;
    return true;
  }

  /**
   * Expands an Emmet abbreviation before the cursor in HTML-like files and JSX, as VS Code does on Tab.
   * @returns whether one was expanded
   */
  private expandAbbreviation() {
    const tab = this.tab;
    const document = tab?.document;
    const markup = ["html", "vue", "svelte", "astro", "xml", "php"];
    const jsx = ["jsx", "tsx"];
    if (
      !tab ||
      !document ||
      !tab.language ||
      ![...markup, ...jsx].includes(tab.language)
    )
      return false;
    const { line, column } = document.cursor;
    const before = document.lines[line].slice(0, column);
    const abbreviation = /[\w.#>+^*$\-[\]="' {}]+$/
      .exec(before)?.[0]
      ?.trimStart();
    if (!abbreviation) return false;
    const unit = document.indentation.useTabs
      ? "\t"
      : " ".repeat(document.indentation.size);
    const expanded = expandEmmet(abbreviation, {
      jsx: jsx.includes(tab.language),
      indent: indentOf(document.lines[line]),
      unit,
    });
    if (!expanded) return false;
    const start = { line, column: column - abbreviation.length };
    document.replace(start, document.cursor, expanded.text, "edit");
    const head = expanded.text.slice(0, expanded.cursor).split("\n");
    document.setCursor({
      line: line + head.length - 1,
      column: (head.length === 1 ? start.column : 0) + head.at(-1)!.length,
    });
    return true;
  }

  /** After the text or cursor changed: keeps the cursor in view and the find results current. */
  afterEdit() {
    const tab = this.tab;
    if (tab?.document && tab.folds?.size)
      for (const start of foldsHiding(
        tab.document.lines,
        tab.folds,
        tab.document.cursor.line,
      ))
        tab.folds.delete(start);
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
    const here = {
      path: tab.path ?? "",
      line: document.cursor.line,
      column: document.cursor.column,
    };
    const last = this.lastLocation;
    if (
      center &&
      last &&
      !this.navigating &&
      (last.path !== here.path ||
        Math.abs(last.line - here.line) > NAVIGATION_LINES)
    ) {
      this.back.push(last);
      if (this.back.length > 50) this.back.shift();
      this.forward = [];
    }
    this.lastLocation = here;
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
    const visible = this.visibleOf(tab);
    const first = visible.findIndex((line) => line >= tab.scrollTop);
    const line =
      visible[Math.max(0, Math.min(visible.length - 1, first + row))];
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
    if (
      document.extras.length &&
      ["left", "right", "home", "end", "up", "down"].includes(key.name) &&
      !key.alt
    ) {
      document.moveAll((one) => {
        if (key.name === "left") one.left(key.shift, key.ctrl);
        else if (key.name === "right") one.right(key.shift, key.ctrl);
        else if (key.name === "home") one.home(key.shift);
        else if (key.name === "end") one.end(key.shift);
        else one.vertical(key.name === "up" ? -1 : 1, key.shift);
      });
      return this.afterEdit();
    }
    if (document.extras.length) {
      if (key.name === "text" || key.name === "paste") {
        document.editAll("type", key.text!.replace(/\n/g, " "));
        return this.afterEdit();
      }
      if (key.name === "backspace" || key.name === "delete") {
        document.editAll(key.name);
        return this.afterEdit();
      }
    }
    switch (key.name) {
      case "left":
        document.left(select, word);
        break;
      case "right":
        document.right(select, word);
        break;
      case "up":
      case "down": {
        const step = key.name === "up" ? -1 : 1;
        if (key.ctrl && !key.shift) return this.scroll(step);
        const visible = this.visibleOf(this.tab!);
        const index = visible.indexOf(document.cursor.line);
        const target = visible[index + step];
        document.verticalTo(
          target ?? (step < 0 ? -1 : document.lines.length),
          select,
        );
        break;
      }
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
        else if (!this.nextSnippetStop() && !this.expandSnippet())
          document.indent();
        break;
      case "escape":
        if (this.find) {
          this.find = null;
          break;
        }
        if (this.zen && !document.hasSelection && !document.extras.length) {
          this.zen = false;
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
      case "f2":
        return this.renameSymbol();
      case "f12":
        return void this.goToDefinition();
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
    const scope = find.scope;
    if (scope)
      find.matches = find.matches.filter(
        (match) =>
          (match.line > scope[0].line ||
            (match.line === scope[0].line && match.start >= scope[0].column)) &&
          (match.line < scope[1].line ||
            (match.line === scope[1].line && match.end <= scope[1].column)),
      );
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

  /** Limits the find to the selection, or lifts the limit, as the find widget's Find in Selection (⌥L). */
  toggleFindInSelection() {
    const find = this.find;
    const document = this.tab?.document;
    if (!find || !document) return;
    find.scope = find.scope
      ? undefined
      : document.hasSelection
        ? document.range()
        : undefined;
    this.updateMatches(false);
    this.changed();
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
    const binding = optionChord(key) ?? bindingOf(key);
    if (key.name === "escape") {
      this.find = null;
      return;
    }
    if (binding === "alt+c") return this.toggleFindOption("caseSensitive");
    if (binding === "alt+w") return this.toggleFindOption("wholeWord");
    if (binding === "alt+r") return this.toggleFindOption("regex");
    if (binding === "alt+l") return this.toggleFindInSelection();
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
    this.paletteSource = null;
    this.palette = {
      field: field(prefix),
      items: [],
      cursor: 0,
      placeholder:
        "Search files by name (append : to go to line, @ to go to a symbol, > to run a command)",
    };
    this.filterPalette();
    this.changed();
  }

  private filterPalette() {
    const palette = this.palette!;
    const value = palette.field.value;
    palette.cursor = 0;
    if (this.paletteSource) {
      palette.items = this.paletteSource(value.trim());
      return;
    }
    if (value.startsWith("@")) {
      const tab = this.tab;
      const document = tab?.document;
      const query = value.slice(1).trim();
      palette.items = document
        ? this.symbolsOf(tab!)
            .flatMap((symbol) => {
              const match = fuzzyMatch(symbol.name, query);
              return match
                ? [
                    {
                      label: symbol.name,
                      detail: `${symbol.kind}  ${symbol.line + 1}`,
                      positions: match.positions,
                      score: match.score,
                      run: () => {
                        document.setCursor({
                          line: symbol.line,
                          column: indentOf(document.lines[symbol.line]).length,
                        });
                        this.focus = "editor";
                        this.reveal(true);
                      },
                    },
                  ]
                : [];
            })
            .sort((a, b) => (query ? b.score - a.score : 0))
        : [];
      return;
    }
    if (value.startsWith(">")) {
      const query = value.slice(1).trim();
      const recent = this.recentCommands;
      const rank = (action: string) =>
        recent.includes(action) ? recent.indexOf(action) : recent.length;
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
                  detail:
                    recent.includes(command.action) && !query
                      ? `recently used${key ? `  ${key}` : ""}`
                      : key,
                  positions: match.positions,
                  run: () => {
                    this.recentCommands = [
                      command.action,
                      ...recent.filter((action) => action !== command.action),
                    ].slice(0, 10);
                    command.run();
                  },
                  score: match.score,
                  rank: rank(command.action),
                },
              ]
            : [];
        })
        .sort((a, b) => (query ? b.score - a.score : a.rank - b.rank));
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

  /** A list Quick Open shows instead of files, for language and indentation pickers; cleared when it closes. */
  private paletteSource: ((query: string) => PaletteItem[]) | null = null;

  /** Commands run from Quick Open, newest first, listed first next time, as VS Code's recently used. */
  private recentCommands: string[] = [];

  /** Runs a Quick Open entry. */
  choosePalette(index: number) {
    const item = this.palette?.items[index];
    this.palette = null;
    this.paletteSource = null;
    item?.run();
    this.changed();
  }

  private paletteKey(key: KeyEvent) {
    const palette = this.palette!;
    if (key.name === "escape") {
      this.palette = null;
      this.paletteSource = null;
    } else if (key.name === "enter") this.choosePalette(palette.cursor);
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
    const search = this.settingsView.search.value;
    if (!search.includes("@modified"))
      return pageRows(this.settingsView.category, search);
    const defaults = this.defaults();
    const rows = pageRows(
      this.settingsView.category,
      search.replace("@modified", "").trim(),
    );
    const modified = (row: PageRow) =>
      row.kind === "setting" &&
      JSON.stringify(valueAt(this.config, row.spec.key)) !==
        JSON.stringify(valueAt(defaults, row.spec.key));
    return rows.filter((row, index) =>
      row.kind === "setting"
        ? modified(row)
        : rows
            .slice(index + 1)
            .find(
              (next) =>
                next.kind === "setting" ||
                (next.kind === "heading" && next.level <= row.level),
            ) &&
          rows
            .slice(index + 1)
            .some(
              (next, offset) =>
                next.kind === "setting" &&
                modified(next) &&
                !rows
                  .slice(index + 1, index + 1 + offset)
                  .some(
                    (between) =>
                      between.kind === "heading" && between.level <= row.level,
                  ),
            ),
    );
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
      for (const tab of this.allTabs()) {
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
      const tab = this.allTabs().find(
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

  /** Opens the context menu of a search result row: replace or dismiss it, copy it, as VS Code's. */
  searchMenu(index: number, x: number, y: number) {
    const row = this.searchRows()[index];
    if (!row) return;
    this.search.cursor = index;
    const view = this.search;
    const dismiss = () => {
      if (row.kind === "file")
        view.results = view.results.filter((result) => result !== row.result);
      else {
        row.result.matches = row.result.matches.filter(
          (match) => match !== row.match,
        );
        if (!row.result.matches.length)
          view.results = view.results.filter((result) => result !== row.result);
      }
      this.changed();
    };
    this.menu = {
      x,
      y,
      cursor: 0,
      items: [
        ...(view.replacing
          ? [
              {
                label:
                  row.kind === "file" ? "Replace All in This File" : "Replace",
                run: () => {
                  void this.replaceInFolder([
                    row.kind === "file"
                      ? row.result
                      : { path: row.result.path, matches: [row.match] },
                  ]);
                },
              },
            ]
          : []),
        { label: "Dismiss", run: dismiss },
        {
          label: "Copy",
          separator: true,
          run: () =>
            void this.copy(
              row.kind === "file" ? row.result.path : row.match.text.trim(),
            ),
        },
        { label: "Copy Path", run: () => void this.copy(row.result.path) },
        {
          label: "Copy All",
          run: () =>
            void this.copy(
              view.results
                .map((result) =>
                  [
                    result.path,
                    ...result.matches.map(
                      (match) => `  ${match.line + 1}: ${match.text.trim()}`,
                    ),
                  ].join("\n"),
                )
                .join("\n"),
            ),
        },
        {
          label: "Collapse All",
          separator: true,
          run: () =>
            view.results.forEach((result) => view.collapsed.add(result.path)),
        },
        {
          label: "Clear Search Results",
          run: () => {
            view.results = [];
            view.query = field();
          },
        },
      ],
    };
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
    const binding = optionChord(key) ?? bindingOf(key);
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
        action: "markdownPreview",
        label: "Markdown: Open Preview to the Side",
        run: () => this.openPreview(),
      },
      {
        action: "reopenClosed",
        label: "View: Reopen Closed Editor",
        run: () => this.reopenClosed(),
      },
      {
        action: "toggleFold",
        label: "Toggle Fold",
        run: () => this.toggleFold(),
      },
      { action: "foldAll", label: "Fold All", run: () => this.foldAll(true) },
      {
        action: "unfoldAll",
        label: "Unfold All",
        run: () => this.foldAll(false),
      },
      {
        action: "goToDefinition",
        label: "Go to Definition",
        run: () => void this.goToDefinition(),
      },
      {
        action: "rename",
        label: "Rename Symbol",
        run: () => this.renameSymbol(),
      },
      {
        action: "languageMode",
        label: "Change Language Mode",
        run: () => this.pickLanguage(),
      },
      {
        action: "indentation",
        label: "Change Indentation",
        run: () => this.pickIndentation(),
      },
      {
        action: "selectAllOccurrences",
        label: "Change All Occurrences",
        run: () => this.selectAllOccurrences(),
      },
      {
        action: "splitEditorDown",
        label: "View: Split Editor Down",
        run: () => {
          this.layout = "vertical";
          this.splitEditor();
        },
      },
      {
        action: "toggleLayout",
        label: "View: Toggle Vertical/Horizontal Editor Layout",
        run: () =>
          void (this.layout =
            this.layout === "vertical" ? "horizontal" : "vertical"),
      },
      {
        action: "zenMode",
        label: "View: Toggle Zen Mode",
        run: () => void (this.zen = !this.zen),
      },
      {
        action: "toggleMinimap",
        label: "View: Toggle Minimap",
        run: () =>
          this.setSetting("settings.minimap", !this.config.settings.minimap),
      },
      {
        action: "toggleBreadcrumbs",
        label: "View: Toggle Breadcrumbs",
        run: () =>
          this.setSetting(
            "settings.breadcrumbs",
            !this.config.settings.breadcrumbs,
          ),
      },
      {
        action: "saveAll",
        label: "File: Save All",
        run: () => {
          for (const [group, entry] of this.groups.entries()) {
            this.group = group;
            entry.tabs.forEach((tab, index) => {
              if (tab.document?.dirty && tab.path) this.save(index);
            });
          }
        },
      },
      {
        action: "saveAs",
        label: "File: Save As...",
        run: () => {
          const tab = this.tab;
          if (!tab?.document) return;
          this.ask({
            title: "Save As",
            message: `Path, relative to ${basename(this.root)}`,
            input: field(
              tab.path ? relativeTo(this.root, tab.path) : tab.title,
              true,
            ),
            buttons: [
              {
                label: "Save",
                primary: true,
                run: (value) => {
                  if (!value.trim()) return "A file name must be provided.";
                  const path = isAbsolute(value)
                    ? value
                    : resolve(this.root, value.trim());
                  if (tab.path && path !== tab.path) removeBackup(tab.path);
                  tab.path = path;
                  tab.title = basename(path);
                  this.save(this.active);
                },
              },
              { label: "Cancel", run: () => undefined },
            ],
          });
        },
      },
      {
        action: "revertFile",
        label: "File: Revert File",
        run: () => {
          const tab = this.tab;
          if (!tab?.path || !tab.document) return;
          const contents = readText(
            tab.path,
            this.config.limits.maxFileMegabytes,
          );
          if (contents.kind !== "text") return;
          tab.document.setText(contents.text);
          tab.document.markSaved();
          removeBackup(tab.path);
          this.afterEdit();
        },
      },
      {
        action: "compareWithSaved",
        label: "File: Compare Active File with Saved",
        run: () => void this.openChanges(true),
      },
      {
        action: "copyPath",
        label: "File: Copy Path of Active File",
        run: () => this.tab?.path && void this.copy(this.tab.path),
      },
      {
        action: "copyRelativePath",
        label: "File: Copy Relative Path of Active File",
        run: () =>
          this.tab?.path &&
          void this.copy(relativeTo(this.root, this.tab.path)),
      },
      {
        action: "outline",
        label: "View: Show Outline",
        run: () => {
          this.side = this.side === "outline" ? "explorer" : "outline";
          if (!this.config.settings.explorer)
            this.setSetting("settings.explorer", true);
        },
      },
      {
        action: "openChanges",
        label: "Git: Open Changes",
        run: () => void this.openChanges(),
      },
      {
        action: "problems",
        label: "View: Show Problems",
        run: () => this.showProblems(),
      },
      { action: "goBack", label: "Go Back", run: () => this.navigate(-1) },
      { action: "goForward", label: "Go Forward", run: () => this.navigate(1) },
      {
        action: "formatSelection",
        label: "Format Selection",
        run: () => void this.formatDocument(this.active, true),
      },
      {
        action: "blockComment",
        label: "Toggle Block Comment",
        run: () =>
          this.withDocument((document) => {
            const comment = commentOf(this.tab!.language);
            const pair: [string, string] =
              comment && "block" in comment ? comment.block : ["/*", "*/"];
            const [start, end] = document.range();
            const text = document.selectedText();
            const trimmed = text.trim();
            const next =
              trimmed.startsWith(pair[0]) && trimmed.endsWith(pair[1])
                ? text
                    .replace(pair[0], "")
                    .replace(
                      new RegExp(
                        `${pair[1].replace(/[*/]/g, "\\$&")}(?![\\s\\S]*${pair[1].replace(/[*/]/g, "\\$&")})`,
                      ),
                      "",
                    )
                    .replace(/^ /, "")
                    .replace(/ $/, "")
                : `${pair[0]} ${text} ${pair[1]}`;
            const after = document.replace(start, end, next, "edit");
            document.select(start, after);
          }),
      },
      {
        action: "addNextOccurrence",
        label: "Add Selection To Next Find Match",
        run: () =>
          this.withDocument((document) => {
            if (!document.addNextOccurrence()) this.say("No more occurrences");
          }),
      },
      ...(
        [
          ["upper", "Transform to Uppercase"],
          ["lower", "Transform to Lowercase"],
          ["title", "Transform to Title Case"],
          ["sortAscending", "Sort Lines Ascending"],
          ["sortDescending", "Sort Lines Descending"],
          ["join", "Join Lines"],
          ["unique", "Delete Duplicate Lines"],
          ["trim", "Trim Trailing Whitespace"],
        ] as const
      ).map(([transform, label]) => ({
        action: `transform.${transform}`,
        label,
        run: () =>
          this.withDocument((document) => transformLines(document, transform)),
      })),
      {
        action: "openFolder",
        label: "File: Open Folder...",
        run: () =>
          this.ask({
            title: "Open Folder",
            message: "The folder codeee shows instead of this one",
            input: field(this.root),
            buttons: [
              {
                label: "Open",
                primary: true,
                run: (value) => this.switchFolder(value),
              },
              { label: "Cancel", run: () => undefined },
            ],
          }),
      },
      {
        action: "openRecent",
        label: "File: Open Recent...",
        run: () => {
          this.palette = {
            field: field(),
            cursor: 0,
            placeholder: "Select to open",
            items: [],
          };
          this.paletteSource = (query) =>
            this.config.state.recent
              .filter((folder) => folder !== this.root)
              .flatMap((folder) => {
                const match = fuzzyMatch(folder, query);
                return match
                  ? [
                      {
                        label: basename(folder),
                        detail: folder,
                        run: () => void this.switchFolder(folder),
                      },
                    ]
                  : [];
              });
          this.filterPalette();
        },
      },
      {
        action: "wordWrap",
        label: "View: Toggle Word Wrap",
        run: () =>
          this.setSetting("settings.wordWrap", !this.config.settings.wordWrap),
      },
      {
        action: "duplicateLineUp",
        label: "Copy Line Up",
        run: () =>
          this.withDocument((document) => document.duplicateLines(true)),
      },
      {
        action: "splitEditor",
        label: "View: Split Editor",
        run: () => this.splitEditor(),
      },
      {
        action: "focusNextGroup",
        label: "View: Focus Next Editor Group",
        run: () => this.focusGroup((this.group + 1) % this.groups.length),
      },
      {
        action: "focusPreviousGroup",
        label: "View: Focus Previous Editor Group",
        run: () =>
          this.focusGroup(
            (this.group - 1 + this.groups.length) % this.groups.length,
          ),
      },
      {
        action: "goToSymbol",
        label: "Go to Symbol in Editor...",
        run: () => this.openPalette("@"),
      },
      {
        action: "nextProblem",
        label: "Go to Next Problem in Files (Error, Warning, Info)",
        run: () => this.stepProblem(1),
      },
      {
        action: "previousProblem",
        label: "Go to Previous Problem in Files (Error, Warning, Info)",
        run: () => this.stepProblem(-1),
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
      const typed = bindingOf(key);
      const chord = optionChord(key);
      const bound = (binding: string | null) =>
        binding
          ? Object.entries(this.config.keys).find(
              ([, value]) => value === binding,
            )?.[0]
          : undefined;
      const action = bound(typed) ?? bound(chord);
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
      else if (this.tab?.kind === "preview" || this.tab?.kind === "diff") {
        const step = {
          up: -1,
          down: 1,
          pageup: -this.view.rows,
          pagedown: this.view.rows,
        }[key.name];
        if (step) this.tab.scrollTop = Math.max(0, this.tab.scrollTop + step);
      } else if (this.tab?.document) this.editorKey(key);
      else if (key.name === "escape" || key.name === "tab")
        this.focus = "explorer";
    }
    this.changed();
  }
}

let defaultsCache: Config | null = null;

/** @returns the shipped defaults, read once */
const loadDefaultsCached = (): Config => (defaultsCache ??= loadDefaults());
