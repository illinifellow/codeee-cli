/**
 * The main screen, after VS Code's workbench and in gittt's manner: a one-line
 * toolbar with the key of every action and messages at its right end, the
 * explorer, the tab strip, breadcrumbs, the find widget, the code or the
 * settings page, a status bar, and Quick Open, dialogs and context menus
 * drawn over it. Every part answers the mouse.
 */
import { basename, relative, sep } from "node:path";
import { Box, Text } from "ink";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { fieldView, type Field } from "@/field";
import { useKeys } from "@/keys";
import { GIT_LETTERS, isIgnored } from "@/git";
import { languageName, languageOf } from "@/languages";
import { Clickable } from "@/mouse/regions";
import { fit, widthOf } from "@/text";
import { availableUpdate, installUpdate } from "@/update";
import type { Workbench } from "@/workbench";
import { CodeView } from "./editor";
import { stickyLines } from "@/symbols";
import { MarkdownView } from "./markdown";
import { SearchView } from "./search";
import { SettingsPage } from "./settings";
import { useTheme } from "./theme";

/** `ctrl+s` as the toolbar shows it: `^S`. */
export const shortKey = (binding: string) =>
  binding
    .replace(/ctrl\+/g, "^")
    .replace(/alt\+/g, "⌥")
    .replace(/shift\+/g, "⇧")
    .replace(/\^(.)$/, (_whole, key: string) => `^${key.toUpperCase()}`);

/** A field with its cursor, on the field ground. */
export const FieldText = ({
  state,
  width,
  focused,
  placeholder,
}: {
  state: Field;
  width: number;
  focused: boolean;
  placeholder?: string;
}) => {
  const { colors: palette } = useTheme();
  if (!state.value && placeholder && !focused)
    return (
      <Text backgroundColor={palette.field} color={palette.textMuted}>
        {fit(placeholder, width)}
      </Text>
    );
  if (!focused)
    return (
      <Text backgroundColor={palette.field} color={palette.text}>
        {fit(state.value, width)}
      </Text>
    );
  if (state.selected)
    return (
      <Text backgroundColor={palette.field} color={palette.text}>
        <Text backgroundColor={palette.selection}>
          {fit(state.value, Math.min(width, widthOf(state.value)))}
        </Text>
        {" ".repeat(Math.max(0, width - widthOf(state.value)))}
      </Text>
    );
  const [before, under, after] = fieldView(state, width - 1);
  const rest = Math.max(
    0,
    width - widthOf(before) - widthOf(under) - widthOf(after),
  );
  return (
    <Text backgroundColor={palette.field} color={palette.text}>
      {before}
      <Text backgroundColor={palette.cursor} color={palette.cursorText}>
        {under}
      </Text>
      {after}
      {!state.value && placeholder
        ? fit(placeholder.slice(1), rest)
        : " ".repeat(rest)}
    </Text>
  );
};

/**
 * @param props.workbench the editor state
 * @param props.width screen width
 * @param props.height screen height
 */
export const App = ({
  workbench,
  width,
  height,
}: {
  workbench: Workbench;
  width: number;
  height: number;
}) => {
  const theme = useTheme();
  const { colors: palette, glyphs, spacing } = theme;
  const version = useSyncExternalStore(
    workbench.subscribe,
    () => workbench.changes,
  );
  const [explorerWidth, setExplorerWidth] = useState(
    workbench.config.columns.explorer,
  );
  useKeys((key) => workbench.key(key));
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      const found = await availableUpdate();
      if (!stopped && found) {
        workbench.update = found;
        workbench.changed();
      }
    };
    void check();
    const timer = setInterval(
      () => void check(),
      workbench.config.limits.updateCheckHours * 3600 * 1000,
    );
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(
    () => setExplorerWidth(workbench.config.columns.explorer),
    [workbench.config.columns.explorer],
  );
  const { config, tab, focus, find } = workbench;
  const keys = config.keys;
  const showExplorer =
    config.settings.explorer &&
    width >= spacing.explorerMinWidth + spacing.editorMinWidth + 1;
  const sideWidth = showExplorer
    ? Math.max(
        spacing.explorerMinWidth,
        Math.min(explorerWidth, width - spacing.editorMinWidth - 1),
      )
    : 0;
  const mainWidth = width - (showExplorer ? sideWidth + 1 : 0);
  const bodyHeight = Math.max(1, height - 3);
  const findRows = find && tab?.document ? (find.replacing ? 2 : 1) : 0;
  const editorRows = Math.max(1, bodyHeight - 2 - findRows);
  workbench.view = { rows: editorRows, columns: mainWidth };
  workbench.theme = theme;

  const tools = [
    { label: "Open", key: keys.quickOpen, run: () => workbench.openPalette() },
    { label: "New", key: keys.newFile, run: () => workbench.newFile() },
    { label: "Save", key: keys.save, run: () => workbench.save() },
    { label: "Find", key: keys.find, run: () => workbench.openFind(false) },
    {
      label: "Replace",
      key: keys.replace,
      run: () => workbench.openFind(true),
    },
    {
      label: "Line",
      key: keys.goToLine,
      run: () => workbench.openPalette(":"),
    },
    {
      label: "Search",
      key: keys.search,
      run: () => workbench.openSearch(false),
    },
    {
      label: "Explorer",
      key: keys.explorer,
      run: () =>
        workbench.side === "search"
          ? workbench.showExplorer()
          : workbench.setSetting(
              "settings.explorer",
              !config.settings.explorer,
            ),
    },
    {
      label: "Settings",
      key: keys.settings,
      run: () => workbench.openSettings(),
    },
  ];

  const applyUpdate = async () => {
    if (workbench.tabs.some((open) => open.document?.dirty))
      return workbench.say("Save your files before updating", true);
    workbench.say(`Installing ${workbench.update}…`);
    try {
      await installUpdate(workbench.update!);
      workbench.say("Updated; restarting");
      workbench.restart();
    } catch (error) {
      workbench.say((error as Error).message, true);
    }
  };

  const explorer = !showExplorer ? null : workbench.side === "search" ? (
    <SearchView
      workbench={workbench}
      width={sideWidth}
      height={bodyHeight}
      version={version}
    />
  ) : (
    <Explorer
      workbench={workbench}
      width={sideWidth}
      height={bodyHeight}
      version={version}
    />
  );
  const status = workbench.status;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor={theme.surface}
    >
      <Box height={1} width={width} overflow="hidden">
        <Box flexShrink={0}>
          <Text color={palette.accent} bold wrap="truncate">
            {" codeee   "}
          </Text>
        </Box>
        {tools.map((tool) => (
          <Clickable key={tool.label} flexShrink={0} onClick={tool.run}>
            <Text>
              <Text color={palette.accent} bold>
                {shortKey(tool.key)}
              </Text>
              <Text color={palette.text}> {tool.label}</Text>
              <Text>{" ".repeat(spacing.toolbarGap)}</Text>
            </Text>
          </Clickable>
        ))}
        <Box flexGrow={1} />
        <Text
          color={status?.error ? palette.danger : palette.textMuted}
          wrap="truncate-start"
        >
          {status ? `${status.text} ` : ""}
        </Text>
        {workbench.update ? (
          <Clickable flexShrink={0} onClick={() => void applyUpdate()}>
            <Text
              backgroundColor={palette.accent}
              color={palette.accentText}
              bold
            >
              {" Update "}
            </Text>
            <Text> </Text>
          </Clickable>
        ) : null}
      </Box>
      <Text color={palette.border}>{glyphs.rule.repeat(width)}</Text>
      <Box height={bodyHeight}>
        {explorer}
        {showExplorer ? (
          <Clickable
            width={1}
            height={bodyHeight}
            flexDirection="column"
            onPress={() => (move) => {
              const next = Math.max(
                spacing.explorerMinWidth,
                Math.min(width - spacing.editorMinWidth - 1, move.x),
              );
              setExplorerWidth(next);
              if (move.kind === "up")
                workbench.setSetting("columns.explorer", next);
            }}
          >
            <Text
              color={
                focus === "explorer" || focus === "search"
                  ? palette.accent
                  : palette.border
              }
            >
              {`${glyphs.divider}\n`.repeat(bodyHeight).trimEnd()}
            </Text>
          </Clickable>
        ) : null}
        <Box flexDirection="column" width={mainWidth}>
          <TabStrip workbench={workbench} width={mainWidth} version={version} />
          <Breadcrumbs workbench={workbench} width={mainWidth} />
          {findRows ? (
            <FindWidget workbench={workbench} width={mainWidth} />
          ) : null}
          {!tab ? (
            <Welcome
              workbench={workbench}
              width={mainWidth}
              height={editorRows}
            />
          ) : tab.kind === "preview" ? (
            <MarkdownView
              workbench={workbench}
              tab={tab}
              width={mainWidth}
              height={editorRows}
              version={version}
            />
          ) : tab.kind === "settings" ? (
            <SettingsPage
              workbench={workbench}
              width={mainWidth}
              height={editorRows}
              version={version}
            />
          ) : tab.notice ? (
            <Box
              width={mainWidth}
              height={editorRows}
              paddingX={2}
              paddingY={1}
            >
              <Text color={palette.textMuted} wrap="wrap">
                {tab.notice}
              </Text>
            </Box>
          ) : (
            <CodeView
              workbench={workbench}
              tab={tab}
              width={mainWidth}
              height={editorRows}
              focused={focus === "editor" && !find?.field}
              version={version}
            />
          )}
        </Box>
      </Box>
      <StatusBar workbench={workbench} width={width} />
      <Overlays workbench={workbench} width={width} height={height} />
    </Box>
  );
};

/** The explorer: the folder's name, then its tree. */
const Explorer = ({
  workbench,
  width,
  height,
}: {
  workbench: Workbench;
  width: number;
  height: number;
  version: number;
}) => {
  const { colors: palette, glyphs, spacing } = useTheme();
  const rows = workbench.explorerRows();
  const visible = Math.max(1, height - 2);
  const focused = workbench.focus === "explorer";
  if (workbench.explorerCursor < workbench.explorerTop)
    workbench.explorerTop = workbench.explorerCursor;
  if (workbench.explorerCursor >= workbench.explorerTop + visible)
    workbench.explorerTop = workbench.explorerCursor - visible + 1;
  workbench.explorerTop = Math.max(
    0,
    Math.min(workbench.explorerTop, Math.max(0, rows.length - visible)),
  );
  const top = workbench.explorerTop;
  const activePath = workbench.tab?.path;
  const dirty = new Set(
    workbench.tabs.flatMap((tab) =>
      tab.document?.dirty && tab.path ? [tab.path] : [],
    ),
  );
  const lines: ReactNode[] = rows
    .slice(top, top + visible)
    .map((row, offset) => {
      const index = top + offset;
      const icon = row.folder
        ? workbench.icons.folder(row.name, row.expanded)
        : workbench.icons.file(row.name, languageOf(row.path));
      const selected = index === workbench.explorerCursor;
      const background =
        selected && focused
          ? palette.selection
          : row.path === activePath
            ? palette.selectionInactive
            : undefined;
      const indent = " ".repeat(1 + row.depth * spacing.indent);
      const git = workbench.git;
      const state = git
        ? row.folder
          ? git.folders.get(row.path)
          : git.files.get(row.path)
        : undefined;
      const ignored = git ? isIgnored(git, row.path) : false;
      const gitColor = state
        ? {
            modified: palette.modified,
            added: palette.added,
            untracked: palette.added,
            renamed: palette.added,
            deleted: palette.danger,
            conflicted: palette.danger,
            ignored: palette.textMuted,
          }[state]
        : undefined;
      const badge = state
        ? row.folder
          ? glyphs.dirty
          : GIT_LETTERS[state]
        : "";
      const unsaved = dirty.has(row.path) ? glyphs.dirty : "";
      const right = [unsaved, badge].filter(Boolean).join(" ");
      const name = fit(
        row.name,
        Math.max(1, width - widthOf(indent) - 3 - widthOf(right)),
      );
      const nameColor = dirty.has(row.path)
        ? palette.modified
        : (gitColor ??
          (ignored
            ? palette.textMuted
            : row.folder
              ? palette.folder
              : palette.text));
      return (
        <Clickable
          key={row.path}
          height={1}
          width={width}
          onClick={() => {
            workbench.focus = "explorer";
            workbench.openRow(index, false);
          }}
          onRightClick={(event) => {
            workbench.focus = "explorer";
            workbench.explorerMenu(index, event.x, event.y);
          }}
        >
          <Text backgroundColor={background}>
            <Text>{indent}</Text>
            <Text
              color={
                ignored
                  ? palette.textMuted
                  : (icon.color ?? (row.folder ? palette.folder : palette.icon))
              }
            >
              {icon.glyph}
            </Text>
            <Text> </Text>
            <Text color={nameColor}>{name}</Text>
            <Text color={unsaved ? palette.modified : gitColor}>
              {right ? ` ${right} ` : " "}
            </Text>
          </Text>
        </Clickable>
      );
    });
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={palette.textMuted}>{fit(" EXPLORER", width)}</Text>
      <Clickable
        height={1}
        width={width}
        onClick={() => {
          workbench.focus = "explorer";
          workbench.changed();
        }}
        onRightClick={(event) => workbench.explorerMenu(-1, event.x, event.y)}
      >
        <Text bold color={palette.text}>
          {fit(` ${basename(workbench.root).toUpperCase()}`, width)}
        </Text>
      </Clickable>
      <Clickable
        flexDirection="column"
        width={width}
        height={visible}
        onWheel={(step) => {
          workbench.explorerTop = Math.max(
            0,
            Math.min(rows.length - visible, workbench.explorerTop + step * 3),
          );
          workbench.explorerCursor = Math.max(
            workbench.explorerTop,
            Math.min(
              workbench.explorerCursor,
              workbench.explorerTop + visible - 1,
            ),
          );
          workbench.changed();
        }}
        onRightClick={(event) => workbench.explorerMenu(-1, event.x, event.y)}
      >
        {lines}
      </Clickable>
    </Box>
  );
};

/** The tabs, as VS Code draws them: icon, name, a dot when unsaved or × to close. */
const TabStrip = ({
  workbench,
  width,
}: {
  workbench: Workbench;
  width: number;
  version: number;
}) => {
  const { colors: palette, glyphs } = useTheme();
  const tabs = workbench.tabs.map((tab, index) => {
    const icon =
      tab.kind === "settings"
        ? { glyph: glyphs.settings, color: palette.icon }
        : workbench.icons.file(tab.title, tab.language);
    const label = ` ${icon.glyph} ${tab.title} ${tab.document?.dirty ? glyphs.dirty : glyphs.close} `;
    return { tab, index, icon, label, width: widthOf(label) };
  });
  let start = 0;
  const activeEnd = tabs
    .slice(0, workbench.active + 1)
    .reduce((total, entry) => total + entry.width, 0);
  while (
    start < workbench.active &&
    activeEnd -
      tabs.slice(0, start).reduce((total, entry) => total + entry.width, 0) >
      width
  )
    start++;
  return (
    <Box height={1} width={width} overflow="hidden">
      {tabs.slice(start).map(({ tab, index, icon }) => {
        const active = index === workbench.active;
        const color = active ? palette.text : palette.textMuted;
        return (
          <Clickable
            key={tab.id}
            flexShrink={0}
            onClick={() => workbench.activate(index)}
          >
            <Text
              backgroundColor={active ? palette.lineHighlight : undefined}
              underline={false}
            >
              <Text color={active ? palette.accent : palette.border}>
                {active ? "▎" : " "}
              </Text>
              <Text color={icon.color ?? palette.icon}>{icon.glyph}</Text>
              <Text
                color={tab.document?.dirty ? palette.modified : color}
                italic={false}
              >
                {" "}
                {tab.title}{" "}
              </Text>
            </Text>
            <Clickable onClick={() => workbench.close(index)}>
              <Text
                backgroundColor={active ? palette.lineHighlight : undefined}
                color={tab.document?.dirty ? palette.modified : color}
              >
                {tab.document?.dirty ? glyphs.dirty : glyphs.close}{" "}
              </Text>
            </Clickable>
          </Clickable>
        );
      })}
    </Box>
  );
};

/** The path of the active file, folder by folder. */
const Breadcrumbs = ({
  workbench,
  width,
}: {
  workbench: Workbench;
  width: number;
}) => {
  const { colors: palette } = useTheme();
  const tab = workbench.tab;
  const parts =
    tab?.kind === "settings"
      ? ["Settings"]
      : tab?.path
        ? relative(workbench.root, tab.path).split(sep)
        : tab
          ? [tab.title]
          : [];
  const document = tab?.document;
  if (document && tab) {
    const symbols = workbench.symbolsOf(tab);
    const { line } = document.cursor;
    const openers = new Set([
      ...stickyLines(document.lines, line + 1, 6),
      line,
    ]);
    parts.push(
      ...symbols
        .filter((symbol) => openers.has(symbol.line))
        .map((symbol) => symbol.name),
    );
  }
  return (
    <Text color={palette.textMuted}>
      {fit(parts.length ? ` ${parts.join(" › ")}` : "", width)}
    </Text>
  );
};

/** The find widget, right-aligned over the code as in VS Code. */
const FindWidget = ({
  workbench,
  width,
}: {
  workbench: Workbench;
  width: number;
}) => {
  const { colors: palette, glyphs, spacing } = useTheme();
  const find = workbench.find!;
  const fieldWidth = Math.max(8, Math.min(spacing.findWidth, width - 30));
  const count = find.query.value
    ? find.matches.length
      ? `${find.current + 1} of ${find.matches.length}`
      : "No results"
    : "";
  const option = (label: string, on: boolean, run: () => void) => (
    <Clickable onClick={run}>
      <Text color={on ? palette.accent : palette.textMuted} bold={on}>
        {" "}
        {label}
      </Text>
    </Clickable>
  );
  const button = (label: string, run: () => void) => (
    <Clickable onClick={run}>
      <Text color={palette.text}> {label}</Text>
    </Clickable>
  );
  return (
    <Box flexDirection="column" width={width}>
      <Box height={1} width={width} justifyContent="flex-end">
        <Clickable
          onClick={() => {
            find.replacing = !find.replacing;
            workbench.changed();
          }}
        >
          <Text color={palette.textMuted}>{find.replacing ? "▾ " : "▸ "}</Text>
        </Clickable>
        <Clickable
          onClick={() => {
            find.field = "query";
            workbench.focus = "editor";
            workbench.changed();
          }}
        >
          <FieldText
            state={find.query}
            width={fieldWidth}
            focused={find.field === "query"}
            placeholder="Find"
          />
        </Clickable>
        {option(glyphs.caseSensitive, find.options.caseSensitive, () =>
          workbench.toggleFindOption("caseSensitive"),
        )}
        {option(glyphs.wholeWord, find.options.wholeWord, () =>
          workbench.toggleFindOption("wholeWord"),
        )}
        {option(glyphs.regex, find.options.regex, () =>
          workbench.toggleFindOption("regex"),
        )}
        <Text
          color={
            find.query.value && !find.matches.length
              ? palette.danger
              : palette.textMuted
          }
        >{` ${count.padEnd(12)}`}</Text>
        {button(glyphs.previous, () => workbench.findStep(-1))}
        {button(glyphs.next, () => workbench.findStep(1))}
        {button(glyphs.close, () => {
          workbench.find = null;
          workbench.changed();
        })}
        <Text> </Text>
      </Box>
      {find.replacing ? (
        <Box height={1} width={width} justifyContent="flex-end">
          <Clickable
            onClick={() => {
              find.field = "replacement";
              workbench.focus = "editor";
              workbench.changed();
            }}
          >
            <FieldText
              state={find.replacement}
              width={fieldWidth}
              focused={find.field === "replacement"}
              placeholder="Replace"
            />
          </Clickable>
          {button(glyphs.replace, () => workbench.replaceOne())}
          {button(glyphs.replaceAll, () => workbench.replaceAll())}
          <Text>{" ".repeat(19)}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

/** What the editor area shows with no tab open: VS Code's empty editor shortcuts. */
const Welcome = ({
  workbench,
  width,
  height,
}: {
  workbench: Workbench;
  width: number;
  height: number;
}) => {
  const { colors: palette } = useTheme();
  const keys = workbench.config.keys;
  const entries = [
    ["Go to File", keys.quickOpen, () => workbench.openPalette()],
    ["Show All Commands", keys.quickOpen, () => workbench.openPalette(">")],
    ["New File", keys.newFile, () => workbench.newFile()],
    ["Find in File", keys.find, () => workbench.openFind(false)],
    [
      "Toggle Explorer",
      keys.explorer,
      () =>
        workbench.setSetting(
          "settings.explorer",
          !workbench.config.settings.explorer,
        ),
    ],
    ["Open Settings", keys.settings, () => workbench.openSettings()],
  ] as const;
  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      <Text color={palette.accent} bold>
        codeee
      </Text>
      <Text> </Text>
      {entries.map(([label, key, run]) => (
        <Clickable key={label} height={1} onClick={run}>
          <Text>
            <Text color={palette.textMuted}>{label.padStart(20)}</Text>
            <Text> </Text>
            <Text color={palette.accent}>
              {`${shortKey(key)}${label === "Show All Commands" ? " >" : ""}`.padEnd(
                10,
              )}
            </Text>
          </Text>
        </Clickable>
      ))}
    </Box>
  );
};

/** The status bar: cursor, indentation, encoding, line endings, language. */
const StatusBar = ({
  workbench,
  width,
}: {
  workbench: Workbench;
  width: number;
}) => {
  const { colors: palette } = useTheme();
  const tab = workbench.tab;
  const document = tab?.document;
  const items: [string, (() => void) | undefined][] = document
    ? [
        [
          document.hasSelection
            ? `Ln ${document.cursor.line + 1}, Col ${document.cursor.column + 1} (${document.selectedText().length} selected)`
            : `Ln ${document.cursor.line + 1}, Col ${document.cursor.column + 1}`,
          () => workbench.openPalette(":"),
        ],
        [
          document.indentation.useTabs
            ? `Tab Size: ${document.indentation.size}`
            : `Spaces: ${document.indentation.size}`,
          () => workbench.pickIndentation(),
        ],
        ["UTF-8", undefined],
        [document.eol === "\n" ? "LF" : "CRLF", undefined],
        [languageName(tab!.language), () => workbench.pickLanguage()],
        ...(tab?.diagnostics?.length
          ? ([
              [
                `✖ ${tab.diagnostics.filter((problem) => problem.severity === "error").length} ⚠ ${tab.diagnostics.filter((problem) => problem.severity === "warning").length}`,
                () => {
                  const next =
                    tab.diagnostics!.find(
                      (problem) => problem.line > document.cursor.line,
                    ) ?? tab.diagnostics![0];
                  document.setCursor({ line: next.line, column: next.start });
                  workbench.afterEdit();
                },
              ],
            ] as [string, (() => void) | undefined][])
          : []),
      ]
    : [];
  return (
    <Box height={1} width={width} justifyContent="flex-end" overflow="hidden">
      {items.map(([label, run]) => (
        <Clickable key={label} flexShrink={0} onClick={run}>
          <Text color={palette.textMuted}>{label} </Text>
        </Clickable>
      ))}
    </Box>
  );
};

/** Quick Open, dialogs and menus, drawn over the screen. */
const Overlays = ({
  workbench,
  width,
  height,
}: {
  workbench: Workbench;
  width: number;
  height: number;
}) => {
  const { palette: quick, dialog, menu } = workbench;
  const overlay = quick ?? dialog ?? menu;
  if (!overlay) return null;
  const close = () => {
    if (dialog) return;
    workbench.palette = null;
    workbench.menu = null;
    workbench.changed();
  };
  return (
    <Clickable
      modal
      position="absolute"
      width={width}
      height={height}
      onClick={close}
      onRightClick={close}
    >
      <OverlayBox workbench={workbench} width={width} height={height} />
    </Clickable>
  );
};

/** The open overlay itself. */
const OverlayBox = ({
  workbench,
  width,
  height,
}: {
  workbench: Workbench;
  width: number;
  height: number;
}) => {
  const { colors: palette, spacing, glyphs } = useTheme();
  const { palette: quick, dialog, menu } = workbench;
  if (quick) {
    const boxWidth = Math.min(spacing.paletteWidth, width - 4);
    const rows = Math.min(spacing.paletteRows, Math.max(1, height - 8));
    const start = Math.max(
      0,
      Math.min(quick.cursor - Math.floor(rows / 2), quick.items.length - rows),
    );
    return (
      <Box
        position="absolute"
        marginTop={1}
        marginLeft={Math.max(0, Math.floor((width - boxWidth) / 2))}
        width={boxWidth}
        flexDirection="column"
        borderStyle="round"
        borderColor={palette.accent}
        backgroundColor={palette.background}
        borderBackgroundColor={palette.background}
      >
        <Box paddingX={1}>
          <FieldText
            state={quick.field}
            width={boxWidth - 4}
            focused
            placeholder={quick.placeholder}
          />
        </Box>
        {quick.items.slice(start, start + rows).map((item, offset) => {
          const index = start + offset;
          const selected = index === quick.cursor;
          const labelChars = [...item.label];
          const detail = item.detail ? `  ${item.detail}` : "";
          const room = boxWidth - 4;
          return (
            <Clickable
              key={`${index}-${item.label}`}
              height={1}
              onClick={() => workbench.choosePalette(index)}
            >
              <Text
                backgroundColor={
                  selected ? palette.selection : palette.background
                }
              >
                <Text> </Text>
                {labelChars.map((character, position) => (
                  <Text
                    key={position}
                    color={
                      item.positions?.includes(position)
                        ? palette.accent
                        : palette.text
                    }
                    bold={item.positions?.includes(position)}
                  >
                    {character}
                  </Text>
                ))}
                <Text color={palette.textMuted}>
                  {fit(detail, Math.max(0, room - widthOf(item.label)))}
                </Text>
                <Text> </Text>
              </Text>
            </Clickable>
          );
        })}
        {!quick.items.length ? (
          <Text color={palette.textMuted}> No matching results</Text>
        ) : null}
      </Box>
    );
  }
  if (dialog) {
    const boxWidth = Math.min(spacing.dialogWidth, width - 4);
    return (
      <Box
        position="absolute"
        marginTop={Math.max(1, Math.floor(height / 2) - 6)}
        marginLeft={Math.max(0, Math.floor((width - boxWidth) / 2))}
        width={boxWidth}
        flexDirection="column"
        borderStyle="round"
        borderColor={palette.accent}
        backgroundColor={palette.background}
        borderBackgroundColor={palette.background}
        paddingX={1}
      >
        <Text bold color={palette.text} wrap="wrap">
          {dialog.title}
        </Text>
        {dialog.message ? (
          <Text color={palette.textMuted} wrap="wrap">
            {dialog.message}
          </Text>
        ) : null}
        {dialog.input ? (
          <Box marginTop={1}>
            <FieldText
              state={dialog.input}
              width={boxWidth - 4}
              focused={dialog.focus === -1}
            />
          </Box>
        ) : null}
        {dialog.error ? (
          <Text color={palette.danger} wrap="wrap">
            {glyphs.error} {dialog.error}
          </Text>
        ) : null}
        <Box justifyContent="flex-end" gap={2} marginTop={1}>
          {dialog.buttons.map((button, index) => (
            <Clickable
              key={button.label}
              onClick={() => workbench.press(index)}
            >
              <Text
                bold={button.primary}
                color={button.primary ? palette.accentText : palette.text}
                backgroundColor={
                  button.primary ? palette.accent : palette.field
                }
                underline={index === dialog.focus}
              >{` ${button.label} `}</Text>
            </Clickable>
          ))}
        </Box>
      </Box>
    );
  }
  if (menu) {
    const labelWidth =
      Math.max(...menu.items.map((item) => widthOf(item.label))) + 4;
    const keyWidth = Math.max(
      0,
      ...menu.items.map((item) => widthOf(item.key ? shortKey(item.key) : "")),
    );
    const boxWidth = Math.min(
      Math.max(spacing.menuWidth, labelWidth + keyWidth + 4),
      width - 2,
    );
    const boxHeight =
      menu.items.length +
      menu.items.filter((item) => item.separator).length +
      2;
    const left = Math.max(0, Math.min(menu.x, width - boxWidth));
    const top = Math.max(0, Math.min(menu.y, height - boxHeight));
    return (
      <Box
        position="absolute"
        marginTop={top}
        marginLeft={left}
        width={boxWidth}
        flexDirection="column"
        borderStyle="round"
        borderColor={palette.border}
        backgroundColor={palette.background}
        borderBackgroundColor={palette.background}
      >
        {menu.items.map((item, index) => (
          <Box key={item.label} flexDirection="column">
            {item.separator ? (
              <Text color={palette.border}>
                {glyphs.rule.repeat(boxWidth - 2)}
              </Text>
            ) : null}
            <Clickable height={1} onClick={() => workbench.chooseMenu(index)}>
              <Text
                backgroundColor={
                  index === menu.cursor ? palette.selection : palette.background
                }
              >
                <Text color={palette.text}>
                  {fit(` ${item.label}`, boxWidth - 3 - keyWidth)}
                </Text>
                <Text color={palette.textMuted}>
                  {(item.key ? shortKey(item.key) : "").padStart(keyWidth)}{" "}
                </Text>
              </Text>
            </Clickable>
          </Box>
        ))}
      </Box>
    );
  }
  return null;
};
