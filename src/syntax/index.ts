/**
 * Finds the VS Code color theme the user runs (from the settings and installed
 * extensions of VS Code, its Insiders build, VSCodium or Cursor, no editor API
 * needed) with every customization laid over it: `workbench.colorCustomizations`
 * for the screen and `editor.tokenColorCustomizations` for the code, both global
 * and scoped to the theme (`[Dark Modern]`). Falls back to Dark+.
 */
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { parse } from "jsonc-parser"
import type { ThemeRegistrationAny } from "shiki/core"
import { bundledThemes } from "shiki/themes"

/** A TextMate token colour rule. */
export interface TokenRule {
  scope?: string | string[]
  settings: Record<string, string>
}

const SHORTHAND_SCOPES: Record<string, string[]> = {
  comments: ["comment", "punctuation.definition.comment"],
  strings: ["string"],
  keywords: ["keyword", "keyword.control", "storage"],
  numbers: ["constant.numeric"],
  types: ["entity.name.type", "support.type", "support.class"],
  functions: ["entity.name.function", "support.function"],
  variables: ["variable", "entity.name.variable"],
}

/** Editors that share VS Code's settings and theme format: their folder under the user's config folder, and their extensions folder. */
const EDITORS = [
  { config: "Code", extensions: ".vscode" },
  { config: "Code - Insiders", extensions: ".vscode-insiders" },
  { config: "VSCodium", extensions: ".vscode-oss" },
  { config: "Cursor", extensions: ".cursor" },
]

/** @returns the folder that holds each editor's `User/settings.json` on this system */
const configRoot = () => {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support")
  if (platform() === "win32") return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
}

/** Settings files to look in, in order: each editor's, then the Flatpak build of VS Code's. */
const SETTINGS_PATHS = [
  ...EDITORS.map(editor => join(configRoot(), editor.config, "User", "settings.json")),
  join(homedir(), ".var", "app", "com.visualstudio.code", "config", "Code", "User", "settings.json"),
]

/** Folders holding themes: each editor's extensions, then the built-in themes of the usual installs (macOS, Linux packages, Snap, Windows). */
const EXTENSION_ROOTS = [
  ...EDITORS.map(editor => join(homedir(), editor.extensions, "extensions")),
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
  "/usr/share/code/resources/app/extensions",
  "/snap/code/current/usr/share/code/resources/app/extensions",
  join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Microsoft VS Code", "resources", "app", "extensions"),
]

const readJson = async <Shape>(path: string) => parse(await readFile(path, "utf8"), [], { allowTrailingComma: true }) as Shape

const loadThemeFile = async (path: string): Promise<{ colors: Record<string, string>; tokenColors: TokenRule[]; type?: string }> => {
  const theme = await readJson<{ include?: string; type?: string; colors?: Record<string, string>; tokenColors?: TokenRule[] | string }>(path)
  const base = theme.include ? await loadThemeFile(join(dirname(path), theme.include)) : { colors: {}, tokenColors: [] as TokenRule[] }
  const own = typeof theme.tokenColors === "string" ? (await readJson<{ settings?: TokenRule[] }>(join(dirname(path), theme.tokenColors))).settings ?? [] : theme.tokenColors ?? []
  return { type: theme.type ?? base.type, colors: { ...base.colors, ...theme.colors }, tokenColors: [...base.tokenColors, ...own] }
}

/** Finds a theme's file by its id or label among the editor's extensions. */
const findThemePath = async (name: string) => {
  for (const root of EXTENSION_ROOTS) {
    if (!existsSync(root)) continue
    for (const folder of await readdir(root)) {
      const manifest = await readJson<{ contributes?: { themes?: { id?: string; label?: string; path: string }[] } }>(join(root, folder, "package.json")).catch(() => null)
      const match = manifest?.contributes?.themes?.find(theme => theme.id === name || theme.label === name)
      if (match) return join(root, folder, match.path)
    }
  }
  return null
}

const customizationRules = (customizations: Record<string, unknown> | undefined): TokenRule[] => {
  if (!customizations) return []
  const rules: TokenRule[] = []
  for (const [key, scopes] of Object.entries(SHORTHAND_SCOPES)) {
    const value = customizations[key]
    if (typeof value === "string") rules.push({ scope: scopes, settings: { foreground: value } })
    else if (value && typeof value === "object") rules.push({ scope: scopes, settings: value as Record<string, string> })
  }
  return [...rules, ...((customizations.textMateRules as TokenRule[] | undefined) ?? [])]
}

/**
 * @param name `vscode` for the editor's theme, or the name of a bundled shiki theme
 * @returns the theme diffs are highlighted with; an unknown name falls back to Dark+
 */
export const readSyntaxTheme = async (name: string): Promise<ThemeRegistrationAny> => {
  if (name !== "vscode") return ((await (bundledThemes[name as keyof typeof bundledThemes] ?? bundledThemes["dark-plus"])()).default) as ThemeRegistrationAny
  const theme = await readEditorTheme()
  return { type: theme.type, colors: theme.colors, tokenColors: theme.tokenColors } as ThemeRegistrationAny
}

/** VS Code's own settings, read once. */
let editorSettings: Promise<Record<string, unknown>> | null = null

/** @returns the first VS Code-family settings file's values; empty when there is none */
export const readEditorSettings = () => editorSettings ??= (async () => {
  const settingsPath = SETTINGS_PATHS.find(path => existsSync(path))
  return settingsPath ? await readJson<Record<string, unknown>>(settingsPath).catch(() => ({} as Record<string, unknown>)) : {}
})()

/** The editor's theme as codeee uses it. */
export interface EditorTheme {
  /** `workbench.colorTheme`, empty when no editor was found. */
  name: string
  type: "light" | "dark"
  /** Every workbench colour: the theme's, then `workbench.colorCustomizations`, then its `[theme]` block. */
  colors: Record<string, string>
  /** Token rules: the theme's, then `editor.tokenColorCustomizations` and its `[theme]` block. */
  tokenColors: TokenRule[]
  /** Whether a VS Code-family editor and its theme were found. */
  found: boolean
}

let editorTheme: Promise<EditorTheme> | null = null

/** @returns the editor theme in use with all the user's customizations, or Dark+ when no editor is found; read once */
export const readEditorTheme = () => editorTheme ??= (async (): Promise<EditorTheme> => {
  const settings = await readEditorSettings()
  const name = String(settings["workbench.colorTheme"] ?? "")
  const path = name ? await findThemePath(name) : null
  const theme = path ? await loadThemeFile(path).catch(() => null) : null
  const fallback = theme ?? ((await bundledThemes["dark-plus"]()).default as unknown as { colors: Record<string, string>; tokenColors: TokenRule[]; type?: string })
  const tokenCustomizations = settings["editor.tokenColorCustomizations"] as Record<string, unknown> | undefined
  const colorCustomizations = (settings["workbench.colorCustomizations"] ?? {}) as Record<string, unknown>
  const plainColors = (values: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(values ?? {}).filter(([key, value]) => !key.startsWith("[") && typeof value === "string")) as Record<string, string>
  return {
    name,
    type: (theme?.type ?? fallback.type) === "light" || /light/i.test(name) && !theme ? "light" : "dark",
    colors: { ...fallback.colors, ...plainColors(colorCustomizations), ...plainColors(colorCustomizations[`[${name}]`] as Record<string, unknown> | undefined) },
    tokenColors: [...fallback.tokenColors, ...customizationRules(tokenCustomizations), ...customizationRules(tokenCustomizations?.[`[${name}]`] as Record<string, unknown> | undefined)],
    found: Boolean(theme),
  }
})()
