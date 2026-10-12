/**
 * Which language a file is written in, for highlighting and comments. The
 * file associations come from VS Code itself: every language its built-in and
 * installed extensions declare (extensions, file names, name patterns,
 * first-line patterns) is read once at start, then a table of common files
 * covers machines without VS Code, then the shebang. The id is mapped onto the
 * shiki grammar of the same name or alias, so every language shiki bundles
 * (over 240) is highlighted.
 */
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { parse } from "jsonc-parser"
import { bundledLanguagesInfo } from "shiki/langs"

/** A language a VS Code extension declares. */
interface Contribution {
  id: string
  extensions?: string[]
  filenames?: string[]
  filenamePatterns?: string[]
  firstLine?: string
}

/** Folders of built-in and installed VS Code extensions (and its relatives) on the usual installs. */
const EXTENSION_ROOTS = [
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
  "/Applications/Cursor.app/Contents/Resources/app/extensions",
  "/usr/share/code/resources/app/extensions",
  "/snap/code/current/usr/share/code/resources/app/extensions",
  join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Microsoft VS Code", "resources", "app", "extensions"),
  join(homedir(), ".vscode", "extensions"),
  join(homedir(), ".vscode-insiders", "extensions"),
  join(homedir(), ".vscode-oss", "extensions"),
  join(homedir(), ".cursor", "extensions"),
]

/** VS Code language ids whose shiki grammar has another name. */
const VSCODE_TO_SHIKI: Record<string, string> = {
  javascriptreact: "jsx", typescriptreact: "tsx", shellscript: "shellscript", dockercompose: "yaml", "jsonc": "jsonc", "json5": "json5",
  ignore: "ini", properties: "properties", "git-commit": "git-commit", "git-rebase": "git-rebase", "objective-c": "objective-c",
  "objective-cpp": "objective-cpp", "cuda-cpp": "cpp", pip_requirements: "ini", "code-text-binary": "", plaintext: "", "search-result": "",
}

/** Common files, for machines without VS Code and for what its extensions leave out; checked after VS Code's table. */
const EXTENSIONS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "json5", md: "markdown", mdx: "mdx", py: "python", pyi: "python", rb: "ruby", go: "go", rs: "rust",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", m: "objective-c", mm: "objective-cpp", php: "php", sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  fish: "fish", ps1: "powershell", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", cfg: "ini", conf: "ini", xml: "xml", plist: "xml",
  svg: "xml", html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less", styl: "stylus", vue: "vue", svelte: "svelte",
  astro: "astro", sql: "sql", graphql: "graphql", gql: "graphql", lua: "lua", r: "r", dart: "dart", scala: "scala", ex: "elixir",
  exs: "elixir", erl: "erlang", hs: "haskell", clj: "clojure", ml: "ocaml", fs: "fsharp", zig: "zig", nim: "nim", tf: "terraform",
  hcl: "hcl", proto: "proto", dockerfile: "docker", vim: "viml", tex: "latex", diff: "diff", patch: "diff", csv: "csv", typ: "typst",
  prisma: "prisma", sol: "solidity", wasm: "wasm", wat: "wasm", glsl: "glsl", hlsl: "hlsl", pl: "perl", jl: "julia", groovy: "groovy",
  gradle: "groovy", cmake: "cmake", mk: "make", nix: "nix", v: "v", vb: "vb", bat: "bat", cmd: "bat", tsv: "tsv", log: "log", http: "http",
}

/** Whole file names, lower case. */
const FILE_NAMES: Record<string, string> = {
  dockerfile: "docker", containerfile: "docker", makefile: "make", gnumakefile: "make", gemfile: "ruby", rakefile: "ruby", podfile: "ruby",
  vagrantfile: "ruby", brewfile: "ruby", justfile: "just", "cmakelists.txt": "cmake", ".gitignore": "ini", ".gitattributes": "ini",
  ".npmrc": "ini", ".editorconfig": "ini", ".bashrc": "shellscript", ".zshrc": "shellscript", ".profile": "shellscript",
  ".bash_profile": "shellscript", ".zprofile": "shellscript", "tsconfig.json": "jsonc", "jsconfig.json": "jsonc", ".prettierrc": "json",
  ".eslintrc": "json", "package-lock.json": "json", ".babelrc": "json", "go.mod": "go", "cargo.lock": "toml", "pipfile": "toml",
}

/** Interpreters a shebang names, by program name. */
const INTERPRETERS: Record<string, string> = {
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", dash: "shellscript", ksh: "shellscript", fish: "fish", node: "javascript",
  deno: "typescript", bun: "typescript", tsx: "typescript", "ts-node": "typescript", python: "python", python3: "python", ruby: "ruby",
  perl: "perl", php: "php", lua: "lua", Rscript: "r", osascript: "applescript", awk: "awk",
}

/** Shiki language ids by every id and alias. */
const SHIKI = new Map<string, string>()
for (const language of bundledLanguagesInfo) {
  SHIKI.set(language.id, language.id)
  for (const alias of language.aliases ?? []) SHIKI.set(alias, language.id)
}

/** Human names of shiki languages, for the status bar. */
const NAMES = new Map(bundledLanguagesInfo.map(language => [language.id, language.name]))

/** What VS Code's extensions declare, gathered by `loadAssociations`. */
const associations = {
  extensions: new Map<string, string>(),
  names: new Map<string, string>(),
  patterns: [] as { pattern: RegExp; id: string }[],
  firstLines: [] as { pattern: RegExp; id: string }[],
}

/** @returns a regular expression for a VS Code glob such as `*.config.js` or `**\/.github/workflows/*.yml`, matched against the file name or path */
const globPattern = (glob: string) => new RegExp(`(^|/)${glob.replace(/^\*\*\//, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(.*/)?").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`, "i")

/**
 * Reads the languages of every VS Code extension found on this machine; later calls do nothing.
 * @returns once the table is filled; never rejects (unreadable extensions are skipped)
 */
export const loadAssociations = async () => {
  if (associations.extensions.size) return
  for (const root of EXTENSION_ROOTS) {
    if (!existsSync(root)) continue
    for (const folder of await readdir(root).catch(() => [] as string[])) {
      const manifest = await readFile(join(root, folder, "package.json"), "utf8").then(text => parse(text) as { contributes?: { languages?: Contribution[] } }).catch(() => null)
      for (const language of manifest?.contributes?.languages ?? []) {
        for (const extension of language.extensions ?? []) associations.extensions.set(extension.toLowerCase().replace(/^\./, ""), language.id)
        for (const name of language.filenames ?? []) associations.names.set(name.toLowerCase(), language.id)
        for (const glob of language.filenamePatterns ?? []) associations.patterns.push({ pattern: globPattern(glob), id: language.id })
        if (language.firstLine) {
          try {
            associations.firstLines.push({ pattern: new RegExp(language.firstLine), id: language.id })
          } catch {
            // a pattern JavaScript cannot compile (VS Code uses Oniguruma) is left out
          }
        }
      }
    }
  }
}

/** @returns the shiki grammar for a language id from VS Code or the tables, or `null` when shiki has none */
const toShiki = (id: string | undefined) => {
  if (!id) return null
  const mapped = id in VSCODE_TO_SHIKI ? VSCODE_TO_SHIKI[id] : id
  return mapped ? SHIKI.get(mapped) ?? null : null
}

/**
 * Finds a file's language.
 * @param path the file's path
 * @param firstLine its first line, for shebangs and first-line patterns
 * @returns the shiki language id, or `null` for plain text
 */
export const languageOf = (path: string, firstLine = ""): string | null => {
  const name = basename(path).toLowerCase()
  const extensions = name.split(".").slice(1).map((_part, index, parts) => parts.slice(index).join("."))
  const fromVsCode = associations.names.get(name)
    ?? associations.patterns.find(entry => entry.pattern.test(path))?.id
    ?? extensions.map(extension => associations.extensions.get(extension)).find(Boolean)
  const known = toShiki(fromVsCode) ?? toShiki(FILE_NAMES[name]) ?? toShiki(extensions.map(extension => EXTENSIONS[extension]).find(Boolean))
  if (known) return known
  if (name.startsWith(".env")) return "dotenv"
  const shebang = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?([\w.+-]+)/.exec(firstLine)
  if (shebang) return toShiki(INTERPRETERS[shebang[1]] ?? INTERPRETERS[shebang[1].replace(/[\d.]+$/, "")])
  return toShiki(associations.firstLines.find(entry => entry.pattern.test(firstLine))?.id)
}

/**
 * @param language a shiki language id, or `null`
 * @returns its name as people write it (`TypeScript`, `Python`), `Plain Text` for none
 */
export const languageName = (language: string | null) => language ? NAMES.get(language) ?? language : "Plain Text"

/** Line comment markers by shiki language; languages with block comments only are absent. */
const LINE_COMMENTS: [string, string[]][] = [
  ["//", ["javascript", "typescript", "jsx", "tsx", "c", "cpp", "csharp", "java", "kotlin", "swift", "go", "rust", "scala", "dart", "php", "scss", "less", "jsonc", "json5", "groovy", "objective-c", "objective-cpp", "zig", "v", "proto", "glsl", "hlsl", "solidity", "prisma", "fsharp", "typst", "stylus", "hcl", "terraform", "vue", "svelte", "astro"]],
  ["#", ["python", "ruby", "shellscript", "fish", "powershell", "yaml", "toml", "perl", "r", "elixir", "nim", "make", "cmake", "docker", "dotenv", "julia", "coffee", "crystal", "nix", "graphql", "tcl", "awk", "just", "ini", "properties"]],
  ["--", ["sql", "lua", "haskell", "elm", "ada", "vhdl", "plsql"]],
  [";", ["clojure", "lisp", "scheme", "racket", "asm", "nasm"]],
  ["%", ["latex", "tex", "erlang", "matlab"]],
  ["\"", ["viml"]],
  ["'", ["vb"]],
  ["REM", ["bat"]],
]

const COMMENT_BY_LANGUAGE = new Map(LINE_COMMENTS.flatMap(([marker, languages]) => languages.map(language => [language, marker] as const)))

/** Block comments for languages without line comments. */
const BLOCK_COMMENTS: Record<string, [string, string]> = { html: ["<!--", "-->"], xml: ["<!--", "-->"], markdown: ["<!--", "-->"], mdx: ["{/*", "*/}"], css: ["/*", "*/"] }

/**
 * @param language a shiki language id, or `null`
 * @returns how a line is commented out: a line marker, or a block pair for languages that only have blocks; `null` for plain text
 */
export const commentOf = (language: string | null): { line: string } | { block: [string, string] } | null => {
  if (!language) return null
  const line = COMMENT_BY_LANGUAGE.get(language)
  if (line) return { line }
  const block = BLOCK_COMMENTS[language]
  return block ? { block } : null
}
