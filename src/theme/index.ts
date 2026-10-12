/**
 * Themes: every colour, glyph and spacing value codeee draws with, as named
 * tokens. The themes live in `config/settings.json`: golden-brown (dark, warm
 * orange on brown, drawn on the terminal's background) and milk-and-honey
 * (light, milky with amber), the palettes of gittt; their code colours come
 * from the VS Code theme in use and from light-plus. `auto` picks one by the
 * terminal's background, `vscode` takes every colour from the theme VS Code
 * runs. Themes can be
 * changed or added in the user settings: a theme of the user's own names the
 * theme it `extends` (golden-brown when it names none) and everything it leaves
 * out comes from there. The `tokens` section is laid over the result, value by
 * value. Components read the resolved theme and hold no literals.
 */
import { AUTO_THEME, overlay, type Config } from "@/config";
import type { EditorTheme } from "@/syntax";

/** Colours, as `#rrggbb`. */
export interface ColorTokens {
  /** The screen's ground; `transparent` leaves the terminal's own background showing. */
  background: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentText: string;
  selection: string;
  selectionInactive: string;
  /** Toolbar, tab strip, status bar and section headers. */
  header: string;
  /** Input fields. */
  field: string;
  /** Errors, warnings and dangerous buttons. */
  danger: string;
  lineHighlight: string;
  gutter: string;
  gutterActive: string;
  cursor: string;
  cursorText: string;
  findMatch: string;
  findCurrent: string;
  /** The ground of the bracket matching the one at the cursor. */
  bracket: string;
  folder: string;
  /** File and folder icons, as the VS Code icon theme colours them. */
  icon: string;
  /** Unsaved files. */
  modified: string;
  added: string;
}

/** Characters for icons and marks. */
export interface GlyphTokens {
  folderOpen: string;
  folderClosed: string;
  file: string;
  dirty: string;
  close: string;
  pointer: string;
  /** The text cursor in single-line fields. */
  cursor: string;
  search: string;
  rule: string;
  divider: string;
  splitter: string;
  checked: string;
  unchecked: string;
  caseSensitive: string;
  regex: string;
  wholeWord: string;
  previous: string;
  next: string;
  replace: string;
  replaceAll: string;
  error: string;
  update: string;
  dropdown: string;
  /** The settings tab's icon. */
  settings: string;
}

/** Sizes in terminal cells and rows. */
export interface SpacingTokens {
  indent: number;
  toolbarGap: number;
  dialogWidth: number;
  menuWidth: number;
  paletteWidth: number;
  paletteRows: number;
  explorerMinWidth: number;
  editorMinWidth: number;
  findWidth: number;
  pickerWidth: number;
  /** Cells between the line numbers and the code. */
  gutterPadding: number;
  /** Lines kept visible above and below the cursor, as neovim's `scrolloff`. */
  scrollMargin: number;
}

/** A full theme. */
export interface Theme {
  colors: ColorTokens;
  glyphs: GlyphTokens;
  spacing: SpacingTokens;
  /** Code highlighting: `vscode` follows the editor's theme, any other value names a bundled shiki theme. */
  syntax: string;
  /** What the screen paints behind everything: the theme's background, or `undefined` for a transparent one. */
  surface: string | undefined;
}

/** A theme as stored in the config: complete for the shipped themes, partial for the user's own. */
export interface ThemeOverrides {
  /** The theme that fills what this one leaves out; golden-brown when absent. */
  extends?: string;
  colors?: Partial<ColorTokens>;
  glyphs?: Partial<GlyphTokens>;
  spacing?: Partial<SpacingTokens>;
  syntax?: string;
}

/** The theme used on dark terminals and when a named theme does not exist. */
export const DEFAULT_THEME = "golden-brown";

/** The `background` value that leaves the terminal's own background showing. */
export const TRANSPARENT = "transparent";

/** The ground tints are mixed with under a transparent theme when the terminal does not say its background. */
const FALLBACK_GROUND = "#000000";

/** The theme `auto` picks on light terminals. */
export const LIGHT_THEME = "milk-and-honey";

/** The `settings.theme` value that takes every colour from the theme VS Code runs, customizations included. */
export const VSCODE_THEME = "vscode";

/**
 * Reads a VS Code colour as an opaque `#rrggbb`.
 * @param color `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; anything else is no colour
 * @param ground what a translucent colour is laid on
 * @returns the colour blended onto the ground by its alpha, or `undefined`
 */
export const opaque = (color: string | undefined, ground: string) => {
  if (!color || !/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color))
    return undefined;
  const hex =
    color.length <= 5
      ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`
      : color;
  const alpha = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
  const channels = (value: string) =>
    [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
  const base = channels(ground);
  return `#${channels(hex)
    .map((value, index) =>
      Math.round(value * alpha + base[index] * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toLowerCase();
};

/**
 * Maps the workbench colours of a VS Code theme onto codeee's tokens.
 * @param editor the editor's theme with the user's customizations
 * @param base the shipped theme of the same brightness, for colours the theme leaves to VS Code's defaults
 * @returns the colour tokens; translucent colours are blended onto the editor background
 */
export const editorColors = (
  editor: EditorTheme,
  base: ColorTokens,
): ColorTokens => {
  const vs = editor.colors;
  const background =
    opaque(vs["editor.background"], "#000000") ?? base.background;
  const pick = (fallback: string, ...keys: string[]) =>
    keys.map((key) => opaque(vs[key], background)).find(Boolean) ?? fallback;
  const accent = pick(
    base.accent,
    "tab.activeBorder",
    "tab.activeBorderTop",
    "focusBorder",
    "button.background",
  );
  return {
    background,
    text: pick(base.text, "editor.foreground", "foreground"),
    textMuted: pick(
      base.textMuted,
      "descriptionForeground",
      "tab.inactiveForeground",
    ),
    border: pick(
      base.border,
      "sideBar.border",
      "editorGroup.border",
      "panel.border",
    ),
    accent,
    accentText: luminance(accent) > 0.5 ? background : "#ffffff",
    selection: pick(base.selection, "editor.selectionBackground"),
    selectionInactive: pick(
      base.selectionInactive,
      "list.inactiveSelectionBackground",
      "editor.inactiveSelectionBackground",
    ),
    header: pick(
      base.header,
      "editorGroupHeader.tabsBackground",
      "sideBar.background",
    ),
    field: pick(base.field, "input.background"),
    danger: pick(base.danger, "errorForeground", "editorError.foreground"),
    lineHighlight: pick(
      base.lineHighlight,
      "editor.lineHighlightBackground",
      "editor.lineHighlightBorder",
    ),
    gutter: pick(base.gutter, "editorLineNumber.foreground"),
    gutterActive: pick(base.gutterActive, "editorLineNumber.activeForeground"),
    cursor: pick(base.cursor, "editorCursor.foreground"),
    cursorText: pick(background, "editorCursor.background"),
    findMatch: pick(base.findMatch, "editor.findMatchHighlightBackground"),
    findCurrent: pick(base.findCurrent, "editor.findMatchBackground"),
    bracket: pick(base.bracket, "editorBracketMatch.background"),
    folder: pick(
      base.folder,
      "sideBar.foreground",
      "foreground",
      "editor.foreground",
    ),
    icon: pick(base.icon, "icon.foreground"),
    modified: pick(
      base.modified,
      "gitDecoration.modifiedResourceForeground",
      "editorGutter.modifiedBackground",
    ),
    added: pick(
      base.added,
      "gitDecoration.untrackedResourceForeground",
      "editorGutter.addedBackground",
    ),
  };
};

/** Luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
const luminance = (color: string) => {
  const [red, green, blue] = [1, 3, 5].map(
    (index) => parseInt(color.slice(index, index + 2), 16) / 255,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

/**
 * Picks the theme name for `auto`.
 * @param background the terminal background, if it answered
 * @returns the light theme on a light background, the default theme otherwise
 */
export const autoTheme = (background: string | undefined) =>
  background && luminance(background) > 0.5 ? LIGHT_THEME : DEFAULT_THEME;

/**
 * Fills a theme from the themes it extends, nearest last.
 * @param themes every configured theme
 * @param name the theme to complete
 * @param seen themes already on the chain, so a loop ends at the default theme
 * @returns the theme with every token its chain supplies; the default theme alone for a name not in `themes`
 */
const completeTheme = (
  themes: Config["themes"],
  name: string,
  seen = new Set<string>(),
): ThemeOverrides => {
  const theme = themes[name];
  if (!theme || name === DEFAULT_THEME || seen.has(name))
    return themes[DEFAULT_THEME];
  seen.add(name);
  return overlay(
    completeTheme(themes, theme.extends ?? DEFAULT_THEME, seen),
    theme,
  );
};

/**
 * Builds the active theme from the configuration.
 * @param config themes, overrides and `settings.theme`
 * @param background the terminal background; `auto` chooses the theme by it, and a transparent theme mixes its tints with it
 * @param editor VS Code's theme with the user's customizations; `vscode` takes every colour from it, and falls back
 *   to `auto` when no editor was found
 * @returns the theme components draw with: the named theme filled from the themes it extends, then the tokens laid
 *   over it value by value; a name missing from `themes` falls back to the default theme. Under a transparent
 *   background `colors.background` is the terminal's (black when unknown), which opaque overlays such as dialogs
 *   paint, and `surface` is `undefined`
 */
export const resolveTheme = (
  config: Pick<Config, "themes" | "tokens"> & { settings: { theme: string } },
  background: string | undefined,
  editor?: EditorTheme,
): Theme => {
  const fromEditor = config.settings.theme === VSCODE_THEME && editor?.found;
  const name = fromEditor
    ? editor.type === "light"
      ? LIGHT_THEME
      : DEFAULT_THEME
    : config.settings.theme === AUTO_THEME ||
        config.settings.theme === VSCODE_THEME
      ? autoTheme(background)
      : config.settings.theme;
  const shipped = completeTheme(config.themes, name);
  const own = fromEditor
    ? {
        ...shipped,
        colors: editorColors(editor, shipped.colors as ColorTokens),
        syntax: VSCODE_THEME,
      }
    : shipped;
  const theme = overlay(own, config.tokens) as Omit<Theme, "surface">;
  const transparent = theme.colors.background === TRANSPARENT;
  return {
    colors: transparent
      ? { ...theme.colors, background: background ?? FALLBACK_GROUND }
      : theme.colors,
    glyphs: theme.glyphs,
    spacing: theme.spacing,
    syntax: theme.syntax,
    surface: transparent ? undefined : theme.colors.background,
  };
};
