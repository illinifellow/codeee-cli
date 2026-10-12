/**
 * The smaller modules the screen relies on: text fields, fuzzy file matching,
 * language detection, the settings page model and theme resolution. Each test
 * names the user-visible behaviour that breaks when it fails.
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDefaults } from "@/config";
import { editField, field } from "@/field";
import { fuzzyMatch, walkFiles } from "@/files";
import { commentOf, languageOf } from "@/languages";
import { replaceInFile, searchFolder } from "@/search";
import { pageRows, parseValue, SETTINGS, valueAt } from "@/settings";
import { resolveTheme } from "@/theme";

const key = (name: string, text?: string, ctrl = false) => ({
  name,
  ctrl,
  alt: false,
  shift: false,
  text,
});

describe("fields", () => {
  it("replaces a selected seed on typing, as VS Code's find field does", () => {
    const seeded = field("old", true);
    expect(editField(seeded, key("text", "n"))).toMatchObject({
      value: "n",
      cursor: 1,
    });
  });

  it("deletes a word with Ctrl+Backspace", () => {
    expect(
      editField(field("one two"), key("backspace", undefined, true)),
    ).toMatchObject({ value: "one ", cursor: 4 });
  });
});

describe("files and search", () => {
  const root = mkdtempSync(join(tmpdir(), "codeee-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(
    join(root, "src", "index.ts"),
    "const total = add(1, 2)\nexport { total }\n",
  );
  writeFileSync(
    join(root, "src", "add.ts"),
    "export const add = (a: number, b: number) => a + b\n",
  );
  writeFileSync(join(root, "node_modules", "skip.js"), "add\n");

  it("walks files without the excluded folders and ranks file-name matches first", () => {
    const files = walkFiles(root, ["node_modules"], 100);
    expect(files.sort()).toEqual(["src/add.ts", "src/index.ts"]);
    const scores = files
      .map((path) => [path, fuzzyMatch(path, "add")?.score ?? -1] as const)
      .sort((a, b) => b[1] - a[1]);
    expect(scores[0][0]).toBe("src/add.ts");
  });

  it("searches the folder and replaces on disk", async () => {
    const query = {
      query: "add",
      include: "",
      exclude: "",
      caseSensitive: false,
      regex: false,
      wholeWord: true,
    };
    const results = await searchFolder(root, query, {
      exclude: ["node_modules"],
      maxFiles: 100,
      maxMatches: 100,
      maxBytes: 1e6,
    });
    expect(results.map((result) => result.matches.length)).toEqual([1, 1]);
    for (const result of results) await replaceInFile(result, "sum", null);
    expect(readFileSync(join(root, "src", "index.ts"), "utf8")).toContain(
      "sum(1, 2)",
    );
  });

  it("honours files to include", async () => {
    const query = {
      query: "export",
      include: "index.ts",
      exclude: "",
      caseSensitive: false,
      regex: false,
      wholeWord: false,
    };
    const results = await searchFolder(root, query, {
      exclude: [],
      maxFiles: 100,
      maxMatches: 100,
      maxBytes: 1e6,
    });
    expect(results.map((result) => result.path.endsWith("index.ts"))).toEqual([
      true,
    ]);
  });
});

describe("languages", () => {
  it("detects languages by extension, file name and shebang", () => {
    expect(languageOf("a/b.tsx")).toBe("tsx");
    expect(languageOf("Dockerfile")).toBe("docker");
    expect(languageOf("run", "#!/usr/bin/env python3")).toBe("python");
    expect(languageOf("notes")).toBeNull();
  });

  it("knows each language's comment", () => {
    expect(commentOf("python")).toEqual({ line: "#" });
    expect(commentOf("html")).toEqual({ block: ["<!--", "-->"] });
  });
});

describe("settings page", () => {
  const defaults = loadDefaults();

  it("covers every editor setting and every key binding", () => {
    const keys = new Set(SETTINGS.map((spec) => spec.key));
    for (const name of Object.keys(defaults.settings))
      expect(keys.has(`settings.${name}`), name).toBe(true);
    for (const name of Object.keys(defaults.keys))
      expect(keys.has(`keys.${name}`), name).toBe(true);
    for (const spec of SETTINGS)
      expect(valueAt(defaults, spec.key), spec.key).not.toBeUndefined();
  });

  it("searches settings by any word", () => {
    const rows = pageRows(null, "tab size");
    expect(
      rows.some(
        (row) => row.kind === "setting" && row.spec.key === "settings.tabSize",
      ),
    ).toBe(true);
  });

  it("rejects a number field holding text", () => {
    const spec = SETTINGS.find((entry) => entry.key === "settings.tabSize")!;
    expect(parseValue(spec, "four")).toHaveProperty("error");
    expect(parseValue(spec, "4")).toEqual({ value: 4 });
  });
});

describe("themes", () => {
  const defaults = loadDefaults();

  it("picks golden-brown on dark terminals and milk-and-honey on light ones, with gittt's accents", () => {
    expect(
      resolveTheme(
        { ...defaults, settings: { ...defaults.settings, theme: "auto" } },
        "#101010",
      ).colors.accent,
    ).toBe("#ff905c");
    expect(
      resolveTheme(
        { ...defaults, settings: { ...defaults.settings, theme: "auto" } },
        "#fafafa",
      ).colors.accent,
    ).toBe("#b1651a");
  });

  it("takes every colour from VS Code under the vscode theme", () => {
    const editor = {
      name: "X",
      type: "dark" as const,
      found: true,
      tokenColors: [],
      colors: {
        "editor.background": "#0d0d0d",
        "editor.selectionBackground": "#00f0ff54",
      },
    };
    const theme = resolveTheme(
      { ...defaults, settings: { ...defaults.settings, theme: "vscode" } },
      undefined,
      editor,
    );
    expect(theme.colors.background).toBe("#0d0d0d");
    expect(theme.colors.selection).toBe("#09585d");
  });
});

describe("snippets", () => {
  it("fills placeholders, follows the indent and puts the cursor on the first tab stop", async () => {
    const { expandSnippet } = await import("@/snippets");
    const expanded = expandSnippet("const ${1:name} = () => {\n\t$0\n};", {
      fileName: "a.ts",
      indent: "  ",
      unit: "  ",
    });
    expect(expanded.text).toBe("const name = () => {\n    \n  };");
    expect(expanded.cursor).toBe(6);
    const second = expandSnippet(
      "export default function ${TM_FILENAME_BASE}() {\n\t$1\n}",
      { fileName: "page.tsx", indent: "", unit: "  " },
    );
    expect(second.text).toBe("export default function page() {\n  \n}");
    expect(second.cursor).toBe(35);
  });
});

describe("emmet", () => {
  it("expands nested and repeated elements with numbering, and leaves code alone", async () => {
    const { expandEmmet } = await import("@/emmet");
    const options = { jsx: false, indent: "", unit: "  " };
    expect(expandEmmet("ul>li.item$*2", options)).toEqual({
      text: '<ul>\n  <li class="item1"></li>\n  <li class="item2"></li>\n</ul>',
      cursor: 25,
    });
    expect(expandEmmet("div#main.card", { ...options, jsx: true })?.text).toBe(
      '<div id="main" className="card"></div>',
    );
    expect(expandEmmet("user.name", options)).toBeNull();
  });
});

describe("following VS Code", () => {
  it("maps VS Code's editor and file settings onto codeee's", async () => {
    const { fromVsCode } = await import("@/vscode");
    const mapped = fromVsCode({
      "editor.tabSize": 4,
      "editor.renderWhitespace": "boundary",
      "editor.lineNumbers": "relative",
      "files.autoSave": "onWindowChange",
      "editor.wordWrap": "on",
      "files.exclude": { "**/.cache": true, "**/*.log": true },
    });
    expect(mapped.settings).toMatchObject({
      tabSize: 4,
      renderWhitespace: "all",
      lineNumbers: true,
      relativeLineNumbers: true,
      autoSave: "onFocusChange",
      wordWrap: true,
      exclude: [".cache"],
    });
  });
});
