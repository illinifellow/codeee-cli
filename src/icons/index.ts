/**
 * File and folder icons from the icon theme VS Code uses (`workbench.iconTheme`):
 * its associations by file name, extension, language and folder name, and its
 * colours (a font icon's `fontColor`, or the fill of an SVG icon; the theme's
 * `light` section on light themes). A terminal cannot draw the pictures, so
 * each icon id is drawn as one character by the kind of file it stands for;
 * `config.icons` can change the character of a kind or of a single icon id.
 */
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { readEditorSettings } from "@/syntax";

/** An icon theme's associations, as VS Code's icon theme JSON holds them. */
interface Associations {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
}

/** A loaded icon theme. */
interface IconTheme extends Associations {
  folderPath: string;
  iconDefinitions: Record<
    string,
    { iconPath?: string; fontCharacter?: string; fontColor?: string }
  >;
  light?: Associations;
}

/** What to draw for one entry. */
export interface Icon {
  glyph: string;
  /** The theme's colour for the icon, or `undefined` to use the theme token. */
  color?: string;
}

/** Icon ids of common themes (Seti, Minimalistic, Material) by the kind of file they stand for. */
const KINDS: [kind: string, ids: RegExp][] = [
  ["test", /test|spec|rspec|karma|protractor|cucumber|jest|vitest|mocha/],
  ["lock", /lock/],
  ["git", /git|diff/],
  ["style", /css|sass|scss|less|stylus|tailwind|stylelint|postcss/],
  [
    "markup",
    /html|vue|svelte|react|angular|pug|haml|handlebars|twig|liquid|nunjucks|razor|blade|marko|mjml|astro|jsx|tsx|xml/,
  ],
  [
    "data",
    /json|yaml|yml|toml|csv|ini|config|settings|editorconfig|registry|env|properties/,
  ],
  ["database", /database|sql|prisma|sequelize|db/],
  [
    "text",
    /markdown|mdx|text|txt|info|readme|licen[cs]e|contribution|changelog|pdf|word|writer|doc|onenote/,
  ],
  [
    "image",
    /image|svg|favicon|photoshop|illustrator|after_effects|animate|lightroom|indesign|draw|png|jpg|gif/,
  ],
  ["media", /video|sound|audio|premiere|music|mp3|mp4/],
  [
    "package",
    /package|npm|yarn|nodejs|bower|nuget|rubygem|paket|lib|pnpm|cargo/,
  ],
  [
    "build",
    /build|docker|webpack|babel|eslint|gulp|grunt|travis|circleci|appveyor|cmake|gradle|make|vagrant|terraform|ansible|puppet|azure|codecov|codeclimate|vite|rollup|esbuild|jenkins|github|gitlab-ci/,
  ],
  ["shell", /console|terminal|powershell|shell|bash|zsh|fish|bat/],
  ["binary", /binary|disc|webassembly|wasm|exe|dll/],
  ["font", /font/],
  ["archive", /zip|tar|archive|7z|rar/],
  ["sheet", /excel|calc|spreadsheet/],
  ["slides", /powerpoint|impress|keynote/],
  ["code", /./],
];

/** The character drawn for each kind; `config.icons` may change any of them. */
export const DEFAULT_ICON_GLYPHS: Record<string, string> = {
  file: "▫",
  folder: "▸",
  folderExpanded: "▾",
  code: "◆",
  markup: "◇",
  style: "#",
  data: "≡",
  database: "≣",
  text: "¶",
  image: "▣",
  media: "♫",
  package: "▦",
  lock: "⊠",
  git: "±",
  build: "◎",
  shell: "$",
  binary: "⊙",
  font: "ƒ",
  test: "✓",
  archive: "▤",
  sheet: "⊞",
  slides: "▭",
};

/** Folders of built-in and installed extensions on the usual installs. */
const EXTENSION_ROOTS = [
  join(homedir(), ".vscode", "extensions"),
  join(homedir(), ".vscode-insiders", "extensions"),
  join(homedir(), ".vscode-oss", "extensions"),
  join(homedir(), ".cursor", "extensions"),
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
  "/usr/share/code/resources/app/extensions",
];

/** VS Code's default when the setting is absent. */
const DEFAULT_ICON_THEME = "vs-seti";

const readJson = async <Shape>(path: string) =>
  parse(await readFile(path, "utf8")) as Shape;

/**
 * Finds and reads the icon theme VS Code uses.
 * @returns the theme, or `null` when no editor or theme file is found
 */
export const loadIconTheme = async (): Promise<IconTheme | null> => {
  const settings = await readEditorSettings();
  const id = String(settings["workbench.iconTheme"] ?? DEFAULT_ICON_THEME);
  if (!id || id === "null") return null;
  for (const root of EXTENSION_ROOTS) {
    if (!existsSync(root)) continue;
    for (const folder of await readdir(root).catch(() => [] as string[])) {
      const manifest = await readJson<{
        contributes?: { iconThemes?: { id: string; path: string }[] };
      }>(join(root, folder, "package.json")).catch(() => null);
      const theme = manifest?.contributes?.iconThemes?.find(
        (entry) => entry.id === id,
      );
      if (!theme) continue;
      const path = join(root, folder, theme.path);
      const loaded = await readJson<IconTheme>(path).catch(() => null);
      return loaded && { ...loaded, folderPath: dirname(path) };
    }
  }
  return null;
};

/** A colour from an SVG file: its first fill or stroke that is neither white, black nor none. */
const svgColor = (path: string) => {
  try {
    const svg = readFileSync(path, "utf8");
    for (const match of svg.matchAll(
      /(?:fill|stroke)(?:="|:\s*)(#[0-9a-f]{3,8})/gi,
    )) {
      const color = match[1].toLowerCase();
      if (!["#fff", "#ffffff", "#000", "#000000"].includes(color))
        return color.length === 4
          ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`
          : color.slice(0, 7);
    }
  } catch {
    // an icon file that cannot be read keeps the theme colour
  }
  return undefined;
};

/** Resolves icons for the explorer and tabs. */
export class Icons {
  private colors = new Map<string, string | undefined>();

  /**
   * @param theme VS Code's icon theme, or `null` to pick icons by language alone
   * @param glyphs characters by kind and by icon id
   * @param light the colour theme is light, so the icon theme's `light` section applies
   */
  constructor(
    private theme: IconTheme | null,
    private glyphs: Record<string, string>,
    private light: boolean,
  ) {}

  private associations(): Associations[] {
    if (!this.theme) return [];
    return this.light && this.theme.light
      ? [this.theme.light, this.theme]
      : [this.theme];
  }

  private colorOf(id: string) {
    if (!this.theme) return undefined;
    if (this.colors.has(id)) return this.colors.get(id);
    const definition = this.theme.iconDefinitions[id];
    const color =
      definition?.fontColor ??
      (definition?.iconPath?.endsWith(".svg")
        ? svgColor(join(this.theme.folderPath, definition.iconPath))
        : undefined);
    this.colors.set(id, color);
    return color;
  }

  private glyphOf(id: string, fallback: string) {
    if (this.glyphs[id]) return this.glyphs[id];
    const kind =
      KINDS.find(([, pattern]) => pattern.test(id.toLowerCase()))?.[0] ??
      fallback;
    return (
      this.glyphs[kind] ?? DEFAULT_ICON_GLYPHS[kind] ?? DEFAULT_ICON_GLYPHS.file
    );
  }

  /**
   * @param name the file name
   * @param language its VS Code-compatible language id, if known
   * @returns the icon to draw
   */
  file(name: string, language: string | null): Icon {
    const lower = name.toLowerCase();
    const extensions = lower
      .split(".")
      .slice(1)
      .map((_part, index, parts) => parts.slice(index).join("."));
    for (const set of this.associations()) {
      const id =
        set.fileNames?.[lower] ??
        set.fileNames?.[name] ??
        extensions
          .map((extension) => set.fileExtensions?.[extension])
          .find(Boolean) ??
        (language ? set.languageIds?.[language] : undefined);
      if (id)
        return { glyph: this.glyphOf(id, "code"), color: this.colorOf(id) };
    }
    const fallback = this.associations()
      .map((set) => set.file)
      .find(Boolean);
    if (language)
      return {
        glyph: this.glyphOf(language, "code"),
        color: fallback ? this.colorOf(fallback) : undefined,
      };
    return {
      glyph: this.glyphs.file ?? DEFAULT_ICON_GLYPHS.file,
      color: fallback ? this.colorOf(fallback) : undefined,
    };
  }

  /**
   * @param name the folder name
   * @param expanded whether it is open
   * @returns the icon to draw: the open or closed folder mark, coloured as the theme colours that folder
   */
  folder(name: string, expanded: boolean): Icon {
    const lower = name.toLowerCase();
    for (const set of this.associations()) {
      const id =
        (expanded
          ? set.folderNamesExpanded?.[lower]
          : set.folderNames?.[lower]) ??
        (expanded ? set.folderExpanded : set.folder);
      if (id)
        return {
          glyph: expanded
            ? (this.glyphs.folderExpanded ?? DEFAULT_ICON_GLYPHS.folderExpanded)
            : (this.glyphs.folder ?? DEFAULT_ICON_GLYPHS.folder),
          color: this.colorOf(id),
        };
    }
    return {
      glyph: expanded
        ? (this.glyphs.folderExpanded ?? DEFAULT_ICON_GLYPHS.folderExpanded)
        : (this.glyphs.folder ?? DEFAULT_ICON_GLYPHS.folder),
    };
  }
}
