/**
 * The inline diff of a file against its last commit, as VS Code's Open Changes
 * in inline mode: removed lines on a red ground, added lines on a green one,
 * each with its line number, hunks separated. A click on a line opens the file
 * there; the wheel and arrows scroll.
 */
import { Text } from "ink";
import { Clickable } from "@/mouse/regions";
import { fit, mix } from "@/text";
import type { Tab, Workbench } from "@/workbench";
import { useTheme } from "./theme";

/**
 * @param props.workbench the editor state
 * @param props.tab the diff tab
 * @param props.width cells
 * @param props.height rows
 */
export const DiffView = ({
  workbench,
  tab,
  width,
  height,
}: {
  workbench: Workbench;
  tab: Tab;
  width: number;
  height: number;
  version: number;
}) => {
  const { colors: palette, glyphs } = useTheme();
  const rows = tab.diff ?? [];
  if (!rows.length)
    return (
      <Text color={palette.textMuted}>
        {" "}
        No changes against the last commit.
      </Text>
    );
  tab.scrollTop = Math.max(
    0,
    Math.min(tab.scrollTop, Math.max(0, rows.length - height)),
  );
  const numbers = String(
    rows.reduce(
      (most, row) => Math.max(most, row.oldLine ?? 0, row.newLine ?? 0),
      0,
    ),
  ).length;
  return (
    <Clickable
      flexDirection="column"
      width={width}
      height={height}
      onWheel={(step) => {
        tab.scrollTop = Math.max(0, tab.scrollTop + step * 3);
        workbench.changed();
      }}
    >
      {rows.slice(tab.scrollTop, tab.scrollTop + height).map((row, index) => {
        if (row.kind === "hunk")
          return (
            <Text key={index} color={palette.border}>
              {fit(glyphs.rule.repeat(width), width)}
            </Text>
          );
        const ground =
          row.kind === "removed"
            ? mix(palette.danger, palette.background, 0.22)
            : row.kind === "added"
              ? mix(palette.added, palette.background, 0.22)
              : undefined;
        const mark =
          row.kind === "removed" ? "-" : row.kind === "added" ? "+" : " ";
        const number = String(row.newLine ?? row.oldLine ?? "").padStart(
          numbers,
        );
        return (
          <Clickable
            key={index}
            height={1}
            width={width}
            onClick={() =>
              tab.source?.path &&
              workbench.open(tab.source.path, {
                line: Math.max(0, (row.newLine ?? row.oldLine ?? 1) - 1),
              })
            }
          >
            <Text backgroundColor={ground}>
              <Text color={palette.gutter}>{` ${number} `}</Text>
              <Text
                color={
                  row.kind === "removed"
                    ? palette.danger
                    : row.kind === "added"
                      ? palette.added
                      : palette.textMuted
                }
              >
                {mark}{" "}
              </Text>
              <Text color={palette.text}>
                {fit(
                  row.text.replace(/\t/g, "  "),
                  Math.max(1, width - numbers - 4),
                )}
              </Text>
            </Text>
          </Clickable>
        );
      })}
    </Clickable>
  );
};
