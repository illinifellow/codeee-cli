/**
 * The settings page as data, after VS Code's Settings editor: every value of
 * `settings.json` (editor settings, limits, the explorer width and every key
 * binding) with its category, title, description and control, the table of
 * contents, search, and reading and writing a value by its dotted key.
 */
import type { Config } from "@/config";

/** A choice of a dropdown, with the line VS Code shows under it. */
export interface Choice {
  value: string;
  description?: string;
}

/** One setting on the page. */
export interface SettingSpec {
  /** Dotted path into the configuration, e.g. `settings.tabSize`. */
  key: string;
  /** Where it sits in the table of contents, e.g. `Text Editor` › `Cursor`. */
  category: string;
  section: string;
  title: string;
  description: string;
  type: "boolean" | "number" | "string" | "enum" | "list" | "key";
  choices?: Choice[];
  /** Listed under Commonly Used too. */
  common?: boolean;
}

/** The table of contents in VS Code's order. */
export const CATEGORIES: { name: string; sections: string[] }[] = [
  { name: "Commonly Used", sections: [] },
  {
    name: "Text Editor",
    sections: ["Cursor", "Find", "Formatting", "Line Numbers", "Files"],
  },
  { name: "Workbench", sections: ["Appearance", "Explorer"] },
  { name: "Files", sections: ["Exclude", "Size"] },
  {
    name: "Keyboard Shortcuts",
    sections: ["File", "Edit", "Selection", "View", "Go"],
  },
  {
    name: "Advanced",
    sections: ["Highlighting", "Mouse", "Timing", "Startup"],
  },
];

const setting = (
  key: string,
  category: string,
  section: string,
  title: string,
  description: string,
  type: SettingSpec["type"],
  extra: Partial<SettingSpec> = {},
): SettingSpec => ({
  key,
  category,
  section,
  title,
  description,
  type,
  ...extra,
});

/** Key bindings: action, section and the description VS Code gives the command. */
const KEYS: [string, string, string, string][] = [
  ["save", "File", "Save", "Save the active file."],
  ["newFile", "File", "New File", "Open a new untitled file."],
  ["close", "File", "Close Editor", "Close the active editor tab."],
  ["quit", "File", "Quit", "Leave codeee, asking about unsaved files first."],
  ["undo", "Edit", "Undo", "Undo the last edit."],
  ["redo", "Edit", "Redo", "Redo the last undone edit."],
  [
    "copy",
    "Edit",
    "Copy",
    "Copy the selection, or the whole line when nothing is selected.",
  ],
  [
    "cut",
    "Edit",
    "Cut",
    "Cut the selection, or the whole line when nothing is selected.",
  ],
  ["paste", "Edit", "Paste", "Paste from the clipboard."],
  [
    "comment",
    "Edit",
    "Toggle Line Comment",
    "Comment out the selected lines, or uncomment them.",
  ],
  [
    "format",
    "Edit",
    "Format Document",
    "Format the file with Prettier, as VS Code does: the project's Prettier and configuration, or the one the VS Code extension bundles.",
  ],
  ["deleteLine", "Edit", "Delete Line", "Delete the selected lines."],
  [
    "duplicateLine",
    "Edit",
    "Copy Line Down",
    "Copy the selected lines below themselves.",
  ],
  ["moveLineUp", "Edit", "Move Line Up", "Move the selected lines up."],
  ["moveLineDown", "Edit", "Move Line Down", "Move the selected lines down."],
  ["find", "Edit", "Find", "Open the find widget."],
  ["replace", "Edit", "Replace", "Open the find widget with replace."],
  [
    "findNext",
    "Edit",
    "Find Next",
    "Go to the next match; with no search, search for the word at the cursor.",
  ],
  ["findPrevious", "Edit", "Find Previous", "Go to the previous match."],
  [
    "toggleFold",
    "View",
    "Toggle Fold",
    "Fold or unfold the block at the cursor.",
  ],
  [
    "wordWrap",
    "View",
    "Toggle Word Wrap",
    "Wrap long lines at the editor's width, or scroll them sideways.",
  ],
  [
    "reopenClosed",
    "View",
    "Reopen Closed Editor",
    "Open the most recently closed tab again.",
  ],
  [
    "markdownPreview",
    "View",
    "Open Markdown Preview",
    "Show the Markdown file as a document beside it, following every edit.",
  ],
  [
    "goToSymbol",
    "Go",
    "Go to Symbol in Editor",
    "Quick Open with @: the functions, classes, headings and rules of the file.",
  ],
  [
    "nextProblem",
    "Go",
    "Next Problem",
    "Go to the next ESLint problem in the file.",
  ],
  [
    "previousProblem",
    "Go",
    "Previous Problem",
    "Go to the previous ESLint problem in the file.",
  ],
  [
    "search",
    "Edit",
    "Find in Files",
    "Show the Search view and search every file in the folder.",
  ],
  [
    "replaceInFiles",
    "Edit",
    "Replace in Files",
    "Show the Search view with replace, to replace across every file in the folder.",
  ],
  [
    "addNextOccurrence",
    "Selection",
    "Add Selection To Next Find Match",
    "Select the word at the cursor; again, add a cursor at its next occurrence. Typing then edits them all.",
  ],
  ["selectAll", "Selection", "Select All", "Select the whole file."],
  [
    "selectLine",
    "Selection",
    "Expand Line Selection",
    "Select the line; again, add the next one.",
  ],
  ["explorer", "View", "Toggle Explorer", "Show or hide the explorer."],
  [
    "focusExplorer",
    "View",
    "Focus Explorer",
    "Move the keyboard to the explorer.",
  ],
  ["settings", "View", "Open Settings", "Open this page."],
  [
    "quickOpen",
    "Go",
    "Go to File",
    "Quick Open: find a file by name; `:` goes to a line, `>` runs a command.",
  ],
  ["goToLine", "Go", "Go to Line", "Go to a line and column."],
  ["nextTab", "Go", "Next Editor", "Show the next tab."],
  ["previousTab", "Go", "Previous Editor", "Show the previous tab."],
];

/** Every setting, in page order. */
export const SETTINGS: SettingSpec[] = [
  setting(
    "settings.theme",
    "Workbench",
    "Appearance",
    "Color Theme",
    "Specifies the color theme used in codeee. `vscode` takes the theme VS Code runs with all its color customizations; `auto` picks golden-brown or milk-and-honey by the terminal's background.",
    "enum",
    { common: true },
  ),
  setting(
    "settings.iconTheme",
    "Workbench",
    "Appearance",
    "File Icon Theme",
    "Specifies the file icon theme used in the explorer and tabs.",
    "enum",
    {
      common: true,
      choices: [
        {
          value: "vscode",
          description:
            "The icon theme VS Code uses: its associations and colours, drawn as characters.",
        },
        { value: "none", description: "No file icons." },
      ],
    },
  ),
  setting(
    "settings.explorer",
    "Workbench",
    "Explorer",
    "Visible",
    "Controls whether the explorer is shown.",
    "boolean",
  ),
  setting(
    "columns.explorer",
    "Workbench",
    "Explorer",
    "Width",
    "The width of the explorer, in terminal cells. Dragging its edge changes it too.",
    "number",
  ),
  setting(
    "settings.tabSize",
    "Text Editor",
    "Formatting",
    "Tab Size",
    "The number of spaces a tab is equal to. This setting is overridden based on the file contents when Detect Indentation is on.",
    "number",
    { common: true },
  ),
  setting(
    "settings.insertSpaces",
    "Text Editor",
    "Formatting",
    "Insert Spaces",
    "Insert spaces when pressing Tab. This setting is overridden based on the file contents when Detect Indentation is on.",
    "boolean",
    { common: true },
  ),
  setting(
    "settings.detectIndentation",
    "Text Editor",
    "Formatting",
    "Detect Indentation",
    "Controls whether Tab Size and Insert Spaces will be automatically detected when a file is opened based on the file contents.",
    "boolean",
    { common: true },
  ),
  setting(
    "settings.autoIndent",
    "Text Editor",
    "Formatting",
    "Auto Indent",
    "Controls whether the editor keeps the current line's indentation on Enter, and indents after an opening bracket.",
    "boolean",
  ),
  setting(
    "settings.autoClosingBrackets",
    "Text Editor",
    "Formatting",
    "Auto Closing Brackets",
    "Controls whether the editor closes brackets and quotes after you open them, surrounds a selection, and steps over a typed closer.",
    "boolean",
    { common: true },
  ),
  setting(
    "settings.trimTrailingWhitespace",
    "Text Editor",
    "Files",
    "Trim Trailing Whitespace",
    "When enabled, will trim trailing whitespace when saving a file.",
    "boolean",
    { common: true },
  ),
  setting(
    "settings.insertFinalNewline",
    "Text Editor",
    "Files",
    "Insert Final Newline",
    "When enabled, insert a final new line at the end of the file when saving it.",
    "boolean",
  ),
  setting(
    "settings.autoSave",
    "Text Editor",
    "Files",
    "Auto Save",
    "Controls auto save of editors that have unsaved changes.",
    "enum",
    {
      common: true,
      choices: [
        {
          value: "off",
          description: "An editor with changes is never automatically saved.",
        },
        {
          value: "afterDelay",
          description:
            "An editor with changes is automatically saved after a short delay.",
        },
        {
          value: "onFocusChange",
          description:
            "An editor with changes is automatically saved when it loses focus.",
        },
      ],
    },
  ),
  setting(
    "settings.formatOnSave",
    "Text Editor",
    "Formatting",
    "Format On Save",
    "Format a file on save with Prettier, as Format Document does.",
    "boolean",
    { common: true },
  ),
  setting(
    "settings.lineNumbers",
    "Text Editor",
    "Line Numbers",
    "Line Numbers",
    "Controls the display of line numbers.",
    "boolean",
    { common: true },
  ),
  setting(
    "settings.relativeLineNumbers",
    "Text Editor",
    "Line Numbers",
    "Relative Line Numbers",
    "Line numbers are rendered as distance in lines to the cursor position, as neovim's `relativenumber`.",
    "boolean",
  ),
  setting(
    "settings.highlightLine",
    "Text Editor",
    "Cursor",
    "Render Line Highlight",
    "Controls whether the editor highlights the current line.",
    "boolean",
  ),
  setting(
    "settings.lineBlame",
    "Text Editor",
    "Cursor",
    "Current Line Blame",
    "Shows who last changed the line at the cursor, and when, at the end of the line, as GitLens does.",
    "boolean",
    { common: true },
  ),
  setting(
    "settings.colorDecorators",
    "Text Editor",
    "Cursor",
    "Color Decorators",
    "Draws color literals such as #ff905c or rgb(255, 144, 92) on their own color, as Color Highlight does.",
    "boolean",
  ),
  setting(
    "settings.bracketPairColorization",
    "Text Editor",
    "Cursor",
    "Bracket Pair Colorization",
    "Colors matching brackets by their nesting depth.",
    "boolean",
  ),
  setting(
    "settings.guides",
    "Text Editor",
    "Cursor",
    "Indent Guides",
    "Draws a guide at every indent level.",
    "boolean",
  ),
  setting(
    "settings.minimap",
    "Text Editor",
    "Cursor",
    "Minimap",
    "Shows an outline of the whole file at the right edge; click or drag it to scroll.",
    "boolean",
  ),
  setting(
    "settings.eslint",
    "Text Editor",
    "Cursor",
    "ESLint",
    "Lints JavaScript and TypeScript with the project's ESLint and shows each problem at the end of its line, as ESLint with Error Lens does.",
    "boolean",
    { common: true },
  ),
  setting(
    "settings.snippets",
    "Text Editor",
    "Cursor",
    "Tab Completion",
    "Expands a snippet's prefix on Tab, with the snippets of your VS Code extensions and your own.",
    "boolean",
  ),
  setting(
    "settings.stickyScroll",
    "Text Editor",
    "Cursor",
    "Sticky Scroll",
    "Shows the lines that open the blocks around the top of the editor, pinned while you scroll.",
    "boolean",
  ),
  setting(
    "settings.wordWrap",
    "Text Editor",
    "Cursor",
    "Word Wrap",
    "Wraps lines at the editor's width instead of scrolling them sideways.",
    "boolean",
    { common: true },
  ),
  setting(
    "settings.wheelLines",
    "Text Editor",
    "Cursor",
    "Mouse Wheel Scroll Lines",
    "The number of lines one notch of the mouse wheel scrolls.",
    "number",
  ),
  setting(
    "settings.exclude",
    "Files",
    "Exclude",
    "Exclude",
    "Names of files and folders never shown in the explorer or searched.",
    "list",
    { common: true },
  ),
  setting(
    "settings.searchExclude",
    "Files",
    "Exclude",
    "Search: Exclude",
    "Names of folders shown in the explorer but left out of Quick Open.",
    "list",
  ),
  setting(
    "limits.maxFileMegabytes",
    "Files",
    "Size",
    "Max Memory For Large Files MB",
    "Files larger than this are not opened.",
    "number",
  ),
  ...KEYS.map(([action, section, title, description]) =>
    setting(
      `keys.${action}`,
      "Keyboard Shortcuts",
      section,
      title,
      description,
      "key",
    ),
  ),
  setting(
    "limits.lintDelayMs",
    "Advanced",
    "Timing",
    "Lint Delay",
    "Milliseconds after the last change before ESLint runs.",
    "number",
  ),
  setting(
    "limits.autoSaveDelayMs",
    "Advanced",
    "Timing",
    "Auto Save Delay",
    "Milliseconds after the last change before Auto Save saves.",
    "number",
  ),
  setting(
    "limits.highlightChunkLines",
    "Advanced",
    "Highlighting",
    "Chunk Lines",
    "Lines highlighted in one step before codeee looks at input again.",
    "number",
  ),
  setting(
    "limits.highlightMaxLines",
    "Advanced",
    "Highlighting",
    "Max Lines",
    "Files longer than this are shown without highlighting.",
    "number",
  ),
  setting(
    "limits.quickOpenFiles",
    "Advanced",
    "Highlighting",
    "Quick Open Files",
    "The most files Quick Open lists.",
    "number",
  ),
  setting(
    "limits.doubleClickMs",
    "Advanced",
    "Mouse",
    "Double Click Time",
    "The longest pause between the two clicks of a double click, in milliseconds.",
    "number",
  ),
  setting(
    "limits.doubleClickCells",
    "Advanced",
    "Mouse",
    "Double Click Distance",
    "How many cells sideways the second click may land from the first.",
    "number",
  ),
  setting(
    "limits.undoSteps",
    "Advanced",
    "Timing",
    "Undo Steps",
    "How many edits each file can undo.",
    "number",
  ),
  setting(
    "limits.typingGroupMs",
    "Advanced",
    "Timing",
    "Typing Group",
    "Typing with pauses shorter than this, in milliseconds, undoes as one step.",
    "number",
  ),
  setting(
    "limits.watchDebounceMs",
    "Advanced",
    "Timing",
    "Watcher Delay",
    "Changes on disk closer than this, in milliseconds, are read once.",
    "number",
  ),
  setting(
    "limits.statusMs",
    "Advanced",
    "Timing",
    "Message Time",
    "How long a message stays in the toolbar, in milliseconds.",
    "number",
  ),
  setting(
    "limits.errorStatusMs",
    "Advanced",
    "Timing",
    "Error Message Time",
    "How long an error stays in the toolbar, in milliseconds.",
    "number",
  ),
  setting(
    "limits.updateCheckHours",
    "Advanced",
    "Timing",
    "Update Check",
    "Hours between two checks for a new release.",
    "number",
  ),
  setting(
    "limits.recentFolders",
    "Advanced",
    "Startup",
    "Recent Folders",
    "How many folders the start screen offers.",
    "number",
  ),
  setting(
    "limits.rememberedPositions",
    "Advanced",
    "Startup",
    "Remembered Positions",
    "How many files keep the cursor where you left it.",
    "number",
  ),
];

/**
 * @param config the configuration
 * @param key a dotted key
 * @returns the value there
 */
export const valueAt = (config: Config, key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (value, part) => (value as Record<string, unknown> | undefined)?.[part],
      config,
    );

/**
 * @param config the configuration
 * @param key a dotted key
 * @param value the new value
 * @returns a copy of the configuration with the value set
 */
export const withValue = (
  config: Config,
  key: string,
  value: unknown,
): Config => {
  const next = structuredClone(config);
  const parts = key.split(".");
  const holder = parts
    .slice(0, -1)
    .reduce<
      Record<string, unknown>
    >((object, part) => object[part] as Record<string, unknown>, next as unknown as Record<string, unknown>);
  holder[parts.at(-1)!] = value;
  return next;
};

/**
 * @param spec a setting
 * @param config the configuration, for the theme names
 * @returns the dropdown's choices
 */
export const choicesOf = (spec: SettingSpec, config: Config): Choice[] => {
  if (spec.key === "settings.theme")
    return [
      {
        value: "vscode",
        description: "The theme VS Code runs, with every color customization.",
      },
      {
        value: "auto",
        description:
          "golden-brown on dark terminals, milk-and-honey on light ones.",
      },
      ...Object.keys(config.themes).map((value) => ({ value })),
    ];
  return spec.choices ?? [];
};

/** A row of the page: a section heading or a setting. */
export type PageRow =
  | { kind: "heading"; text: string; level: 1 | 2 }
  | { kind: "setting"; spec: SettingSpec };

/**
 * Lays out the page.
 * @param category the table-of-contents entry chosen, or `null` for all
 * @param query search text; matches title, description, key and category, every word anywhere
 * @returns headings and settings in page order
 */
export const pageRows = (category: string | null, query: string): PageRow[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (spec: SettingSpec) =>
    words.every((word) =>
      `${spec.category} ${spec.section} ${spec.title} ${spec.description} ${spec.key}`
        .toLowerCase()
        .includes(word),
    );
  const rows: PageRow[] = [];
  for (const { name, sections } of CATEGORIES) {
    if (category && category !== name) continue;
    if (name === "Commonly Used") {
      if (words.length) continue;
      const common = SETTINGS.filter((spec) => spec.common);
      rows.push(
        { kind: "heading", text: name, level: 1 },
        ...common.map((spec) => ({ kind: "setting" as const, spec })),
      );
      continue;
    }
    const inCategory = SETTINGS.filter(
      (spec) => spec.category === name && matches(spec),
    );
    if (!inCategory.length) continue;
    rows.push({ kind: "heading", text: name, level: 1 });
    for (const section of sections) {
      const specs = inCategory.filter((spec) => spec.section === section);
      if (!specs.length) continue;
      rows.push(
        { kind: "heading", text: section, level: 2 },
        ...specs.map((spec) => ({ kind: "setting" as const, spec })),
      );
    }
  }
  return rows;
};

/**
 * @param query search text
 * @returns how many settings each category holds that match it
 */
export const categoryCounts = (query: string) => {
  const rows = pageRows(null, query);
  const counts = new Map<string, number>();
  let current = "";
  for (const row of rows) {
    if (row.kind === "heading" && row.level === 1) current = row.text;
    else if (row.kind === "setting")
      counts.set(current, (counts.get(current) ?? 0) + 1);
  }
  return counts;
};

/**
 * Reads what was typed into a setting's field.
 * @param spec the setting
 * @param text the field's text
 * @returns the value to store, or a sentence saying why it cannot be stored
 */
export const parseValue = (
  spec: SettingSpec,
  text: string,
): { value: unknown } | { error: string } => {
  if (spec.type === "number") {
    const value = Number(text.trim());
    return text.trim() && Number.isInteger(value) && value >= 0
      ? { value }
      : { error: "Value must be a whole number." };
  }
  if (spec.type === "list")
    return {
      value: text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    };
  if (spec.type === "key")
    return /^((ctrl|alt|shift)\+)*[^+\s]+$/.test(text.trim())
      ? { value: text.trim().toLowerCase() }
      : { error: "Write a key like ctrl+s, alt+up or f3." };
  return { value: text };
};
