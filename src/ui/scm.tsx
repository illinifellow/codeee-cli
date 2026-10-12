/**
 * The Source Control view of the side bar, as VS Code's: the commit message
 * with the Commit button, then Staged Changes and Changes with each file's
 * state letter and a + or − to stage or unstage it. A click on a file opens its
 * changes.
 */
import { relative } from "node:path";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { GIT_LETTERS } from "@/git";
import { languageOf } from "@/languages";
import { Clickable } from "@/mouse/regions";
import { fit, widthOf } from "@/text";
import type { Workbench } from "@/workbench";
import { FieldText } from "./index";
import { useTheme } from "./theme";

/**
 * @param props.workbench the editor state
 * @param props.width cells
 * @param props.height rows
 */
export const ScmView = ({
  workbench,
  width,
  height,
}: {
  workbench: Workbench;
  width: number;
  height: number;
  version: number;
}) => {
  const { colors: palette } = useTheme();
  const scm = workbench.scm;
  const focused = workbench.focus === "scm";
  if (!scm)
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Text color={palette.textMuted}>{fit(" SOURCE CONTROL", width)}</Text>
        <Text color={palette.textMuted}>
          {fit(
            " The folder currently open doesn't have a git repository.",
            width,
          )}
        </Text>
      </Box>
    );
  const rows = workbench.scmRows();
  const staged = rows.filter((entry) => entry.staged).length;
  const lines: ReactNode[] = [];
  rows.forEach((entry, index) => {
    if (index === 0 && staged)
      lines.push(
        <Text key="h-staged" bold color={palette.text}>
          {fit(` STAGED CHANGES  ${staged}`, width)}
        </Text>,
      );
    if (index === staged)
      lines.push(
        <Text key="h-changes" bold color={palette.text}>
          {fit(` CHANGES  ${rows.length - staged}`, width)}
        </Text>,
      );
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const folder = relative(scm.root, entry.path)
      .slice(0, -name.length)
      .replace(/\/$/, "");
    const icon = workbench.icons.file(name, languageOf(entry.path));
    const color = {
      modified: palette.modified,
      added: palette.added,
      untracked: palette.added,
      renamed: palette.added,
      deleted: palette.danger,
      conflicted: palette.danger,
      ignored: palette.textMuted,
    }[entry.state];
    const selected = focused && !scm.typing && index === scm.cursor;
    const tail = ` ${entry.staged ? "−" : "+"} ${GIT_LETTERS[entry.state] || "U"} `;
    lines.push(
      <Box key={`${entry.staged}-${entry.path}`} height={1} width={width}>
        <Clickable
          height={1}
          width={width - widthOf(tail)}
          onClick={() => {
            scm.cursor = index;
            scm.typing = false;
            workbench.focus = "scm";
            void workbench.openScmRow(entry);
          }}
        >
          <Text backgroundColor={selected ? palette.selection : undefined}>
            <Text
              color={icon.color ?? palette.icon}
            >{`   ${icon.glyph} `}</Text>
            <Text
              color={entry.state === "deleted" ? palette.danger : palette.text}
              strikethrough={entry.state === "deleted"}
            >
              {fit(
                name,
                Math.min(widthOf(name), Math.max(1, width - widthOf(tail) - 6)),
              )}
            </Text>
            <Text color={palette.textMuted}>
              {fit(
                folder ? ` ${folder}` : "",
                Math.max(0, width - widthOf(tail) - 6 - widthOf(name)),
              )}
            </Text>
          </Text>
        </Clickable>
        <Clickable onClick={() => void workbench.toggleStage(entry)}>
          <Text backgroundColor={selected ? palette.selection : undefined}>
            <Text
              color={palette.textMuted}
            >{` ${entry.staged ? "−" : "+"}`}</Text>
            <Text color={color}>{` ${GIT_LETTERS[entry.state] || "U"} `}</Text>
          </Text>
        </Clickable>
      </Box>,
    );
  });
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={palette.textMuted}>{fit(" SOURCE CONTROL", width)}</Text>
      <Box height={1} width={width}>
        <Text> </Text>
        <Clickable
          onClick={() => {
            scm.typing = true;
            workbench.focus = "scm";
            workbench.changed();
          }}
        >
          <FieldText
            state={scm.message}
            width={Math.max(4, width - 2)}
            focused={focused && scm.typing}
            placeholder="Message (Enter to commit)"
          />
        </Clickable>
      </Box>
      <Clickable
        height={1}
        width={width}
        onClick={() => void workbench.commitScm()}
      >
        <Text backgroundColor={palette.accent} color={palette.accentText} bold>
          {fit(
            `${" ".repeat(Math.max(0, Math.floor((width - 10) / 2)))}✓ Commit`,
            width - 1,
          )}
        </Text>
      </Clickable>
      {!rows.length ? (
        <Text color={palette.textMuted}>{fit(" No changes", width)}</Text>
      ) : null}
      {lines.slice(0, Math.max(0, height - 3))}
    </Box>
  );
};
