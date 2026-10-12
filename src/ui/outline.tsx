/**
 * The Outline view of the side bar, as VS Code's: the symbols of the active
 * file indented by their nesting, the one around the cursor highlighted; a
 * click goes to it.
 */
import { Box, Text } from "ink";
import { Clickable } from "@/mouse/regions";
import { fit } from "@/text";
import type { Workbench } from "@/workbench";
import { useTheme } from "./theme";

/** Short marks for symbol kinds, as VS Code's outline icons. */
const KIND_MARKS: Record<string, string> = {
  function: "ƒ",
  method: "ƒ",
  class: "◇",
  interface: "◈",
  type: "τ",
  enum: "ε",
  const: "c",
  let: "v",
  var: "v",
  selector: "#",
};

/**
 * @param props.workbench the editor state
 * @param props.width cells
 * @param props.height rows
 */
export const OutlineView = ({
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
  const tab = workbench.tab;
  const document = tab?.document;
  const symbols = tab && document ? workbench.symbolsOf(tab) : [];
  const indentOf = (line: number) =>
    /^[ \t]*/.exec(document!.lines[line])![0].replace(/\t/g, "  ").length;
  const current = document
    ? [...symbols]
        .reverse()
        .find((symbol) => symbol.line <= document.cursor.line)
    : undefined;
  const top = Math.max(
    0,
    Math.min(
      symbols.indexOf(current!) - Math.floor((height - 2) / 2),
      symbols.length - (height - 1),
    ),
  );
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={palette.textMuted}>{fit(" OUTLINE", width)}</Text>
      {!symbols.length ? (
        <Text color={palette.textMuted}>
          {fit(" No symbols found in document", width)}
        </Text>
      ) : null}
      {symbols.slice(top, top + height - 1).map((symbol) => {
        const depth = symbol.kind.startsWith("h")
          ? Number(symbol.kind.slice(1)) - 1
          : Math.floor(indentOf(symbol.line) / 2);
        const mark =
          KIND_MARKS[symbol.kind] ?? (symbol.kind.startsWith("h") ? "#" : "•");
        return (
          <Clickable
            key={`${symbol.line}-${symbol.name}`}
            height={1}
            width={width}
            onClick={() => {
              document!.setCursor({
                line: symbol.line,
                column: Math.max(
                  0,
                  document!.lines[symbol.line].indexOf(symbol.name),
                ),
              });
              workbench.focus = "editor";
              workbench.reveal(true);
              workbench.changed();
            }}
          >
            <Text
              backgroundColor={
                symbol === current ? palette.selectionInactive : undefined
              }
            >
              <Text>{" ".repeat(1 + depth * 2)}</Text>
              <Text color={palette.accent}>{mark} </Text>
              <Text color={palette.text}>
                {fit(symbol.name, Math.max(1, width - 4 - depth * 2))}
              </Text>
            </Text>
          </Clickable>
        );
      })}
    </Box>
  );
};
