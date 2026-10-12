/**
 * `codeee`: asks which folder to open (prefilled with the current directory or
 * the path given as the first argument; a file opens its folder with the file
 * in a tab), remembers it among recent folders, then opens the editor in the
 * terminal's alternate screen with mouse reporting and bracketed paste on.
 * After an update, and in a checkout whenever `dist/app.js` is rebuilt with no
 * unsaved files, codeee replaces itself in place (same process, same folder,
 * same tabs). Leaving by any route, a crash included, gives the terminal back
 * as it was: normal screen, no mouse reporting, the window title restored.
 */
import {
  existsSync,
  realpathSync,
  statSync,
  unwatchFile,
  watchFile,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import {
  ConfigError,
  loadConfig,
  loadState,
  saveState,
  type Config,
} from "@/config";
import { SyntaxHighlighter } from "@/highlight";
import { Icons, loadIconTheme } from "@/icons";
import { dispatchKeys } from "@/keys";
import { loadAssociations } from "@/languages";
import { mouse, startMouse } from "@/mouse";
import { dispatchMouse } from "@/mouse/regions";
import { readEditorTheme, readSyntaxTheme, type EditorTheme } from "@/syntax";
import { queryBackground, terminalBackground } from "@/terminal";
import { resolveTheme, LIGHT_THEME, type Theme } from "@/theme";
import { App } from "@/ui";
import { FolderPicker } from "@/ui/picker";
import { ThemeProvider } from "@/ui/theme";
import { isCheckout } from "@/update";
import { Workbench } from "@/workbench";

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h\x1b[H";
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l";
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
/** xterm's title stack: codeee pushes the title before setting its own and pops it on the way out. */
const SAVE_TITLE = "\x1b[22;0t";
const RESTORE_TITLE = "\x1b[23;0t";

/** The folder being edited, carried over a restart; set by `CODEEE_FOLDER` or the folder picker. */
let folder = process.env.CODEEE_FOLDER;
const argument = process.argv[2] ? resolve(process.argv[2]) : null;
/** A file named on the command line opens in a tab once its folder is open. */
const startFile =
  argument && existsSync(argument) && statSync(argument).isFile()
    ? argument
    : null;

await queryBackground(loadConfig().limits.backgroundQueryMs);
const [editorTheme] = await Promise.all([
  readEditorTheme(),
  loadAssociations(),
]);
const iconTheme = await loadIconTheme();

/** @returns the theme, the syntax highlighter and the icons for a configuration */
const appearance = (config: Config, editor: EditorTheme) => {
  const theme = resolveTheme(config, terminalBackground(), editor);
  const light =
    theme.syntax === "vscode"
      ? editor.type === "light"
      : config.settings.theme === LIGHT_THEME || theme.syntax.includes("light");
  return {
    theme,
    highlighter: new SyntaxHighlighter(readSyntaxTheme(theme.syntax)),
    icons: new Icons(
      config.settings.iconTheme === "none" ? null : iconTheme,
      config.settings.iconTheme === "none"
        ? {
            file: " ",
            code: " ",
            markup: " ",
            style: " ",
            data: " ",
            text: " ",
          }
        : {},
      light,
    ),
  };
};

const Editor = ({
  root,
  onQuit,
  onRestart,
}: {
  root: string;
  onQuit: () => void;
  onRestart: () => void;
}) => {
  const { columns, rows } = useWindowSize();
  const [look, setLook] = useState(() => appearance(loadConfig(), editorTheme));
  const workbench = useMemo(() => {
    const created = new Workbench(
      root,
      look.highlighter,
      look.icons,
      onQuit,
      (config) => {
        const next = appearance(config, editorTheme);
        created.highlighter = next.highlighter;
        created.icons = next.icons;
        for (const tab of created.tabs)
          if (tab.highlight) tab.highlight.retheme(next.highlighter);
        setLook(next);
      },
    );
    created.restart = onRestart;
    activeWorkbench = created;
    if (startFile) created.open(startFile);
    return created;
  }, []);
  useEffect(
    () => void process.stdout.write(`\x1b]0;${basename(root)} — codeee\x07`),
    [],
  );
  return (
    <ThemeProvider value={look.theme as Theme}>
      <App workbench={workbench} width={columns} height={rows} />
    </ThemeProvider>
  );
};

const Root = ({
  initial,
  resumed,
  onQuit,
  onRestart,
}: {
  initial: string;
  resumed: boolean;
  onQuit: () => void;
  onRestart: () => void;
}) => {
  const [root, setRoot] = useState<string | null>(() =>
    resumed ? initial : null,
  );
  const { columns } = useWindowSize();
  if (root) return <Editor root={root} onQuit={onQuit} onRestart={onRestart} />;
  return (
    <ThemeProvider
      value={resolveTheme(loadConfig(), terminalBackground(), editorTheme)}
    >
      <FolderPicker
        initial={initial}
        recent={loadState().recent}
        width={columns}
        onPick={(picked) => {
          const state = loadState();
          try {
            saveState({
              ...state,
              recent: [
                picked,
                ...state.recent.filter((path) => path !== picked),
              ].slice(0, loadConfig().limits.recentFolders),
            });
          } catch (error) {
            if (!(error instanceof ConfigError)) throw error;
          }
          folder = picked;
          setRoot(picked);
        }}
      />
    </ThemeProvider>
  );
};

const { limits } = loadConfig();
process.stdout.write(SAVE_TITLE + ENTER_ALTERNATE_SCREEN + BRACKETED_PASTE_ON);
const { keyboard, stop } = startMouse(
  {
    doubleClickMs: limits.doubleClickMs,
    doubleClickCells: limits.doubleClickCells,
  },
  limits.inputSplitMs,
);
mouse.on("mouse", dispatchMouse);
keyboard.on("data", (chunk: Buffer | string) => dispatchKeys(chunk.toString()));

let terminalRestored = false;
/** Gives the terminal back as codeee found it; runs once, whichever way codeee leaves. */
const restoreTerminal = () => {
  if (terminalRestored) return;
  terminalRestored = true;
  stop();
  process.stdout.write(
    BRACKETED_PASTE_OFF + LEAVE_ALTERNATE_SCREEN + RESTORE_TITLE,
  );
  process.stdin.setRawMode?.(false);
};
process.on("exit", restoreTerminal);

let restarting = false;
/** The open editor, so a rebuild never restarts over unsaved files. */
let activeWorkbench: Workbench | null = null;
const dirty = () => (activeWorkbench ? !activeWorkbench.backupAll() : false);
/** Leaves the screen so the closing handler can start the new codeee in this process. */
const restart = () => {
  if (restarting) return;
  restarting = true;
  instance.unmount();
};
const quit = () => instance.unmount();

const initial =
  folder ??
  (argument ? (startFile ? dirname(startFile) : argument) : process.cwd());
const instance = render(
  <Root
    initial={initial}
    resumed={Boolean(folder) || Boolean(startFile)}
    onQuit={quit}
    onRestart={restart}
  />,
  {
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: Boolean(process.stdout.isTTY),
  },
);
if (startFile) folder = dirname(startFile);

/** An error nothing caught: the screen goes, the terminal comes back, and the error is printed where it stays readable. */
const crash = (error: unknown) => {
  instance.unmount();
  restoreTerminal();
  process.stderr.write(
    `codeee stopped on an unexpected error:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
for (const signal of ["SIGTERM", "SIGHUP"] as const)
  process.once(signal, () => instance.unmount());

const bundle = realpathSync(fileURLToPath(import.meta.url));
if (isCheckout())
  watchFile(bundle, { interval: 1000 }, (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs && !dirty())
      setTimeout(restart, limits.refreshDelayMs);
  });

void instance.waitUntilExit().finally(() => {
  unwatchFile(bundle);
  restoreTerminal();
  if (!restarting) process.exit(0);
  try {
    if (!process.execve) throw new Error("this Node has no process.execve");
    process.execve(
      process.execPath,
      [process.execPath, ...process.execArgv, ...process.argv.slice(1, 2)],
      {
        ...process.env,
        ...(process.env.CODEEE_NEXT_FOLDER || folder
          ? {
              CODEEE_FOLDER: process.env.CODEEE_NEXT_FOLDER || folder,
              CODEEE_NEXT_FOLDER: "",
            }
          : {}),
      },
    );
  } catch (error) {
    process.stdout.write(
      `codeee cannot restart itself here (${(error as Error).message}); start it again to use the new version\n`,
    );
    process.exit(0);
  }
});
