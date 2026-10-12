/**
 * The code area: line numbers, highlighted code scrolled both ways, the
 * current line, the selection, find matches, the bracket matching the one at
 * the cursor, and the cursor itself, drawn cell by cell from the document and
 * its highlighting. Clicks place the cursor, drags select, double clicks select
 * a word, a click in the line numbers selects the line, the wheel scrolls.
 */
import { Box, Text } from "ink";
import { memo, type ReactNode } from "react";
import type { Position } from "@/buffer";
import type { Segment } from "@/highlight";
import { Clickable, type LocalMouseEvent } from "@/mouse/regions";
import { placeText } from "@/text";
import type { Tab, Workbench } from "@/workbench";
import { useTheme } from "./theme";

/** A coloured stretch of a row. */
interface Piece {
  text: string;
  color?: string;
  background?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const compare = (a: Position, b: Position) =>
  a.line - b.line || a.column - b.column;

/**
 * One row of code.
 * @returns the pieces to draw, exactly `width` cells wide
 */
const codeRow = (
  text: string,
  segments: Segment[] | null,
  line: number,
  options: {
    width: number;
    left: number;
    tabSize: number;
    defaultColor: string;
    selection: [Position, Position] | null;
    matches: { start: number; end: number; current: boolean }[];
    brackets: number[];
    cursor: number | null;
    lineBackground?: string;
    colors: {
      selection: string;
      findMatch: string;
      findCurrent: string;
      bracket: string;
      cursor: string;
      cursorText: string;
    };
  },
): Piece[] => {
  const { width, left, tabSize, selection, matches, brackets, cursor, colors } =
    options;
  const pieces: Piece[] = [];
  const push = (piece: Piece) => {
    const last = pieces.at(-1);
    if (
      last &&
      last.color === piece.color &&
      last.background === piece.background &&
      last.bold === piece.bold &&
      last.italic === piece.italic &&
      last.underline === piece.underline
    )
      last.text += piece.text;
    else pieces.push(piece);
  };
  const selected = (column: number) =>
    selection !== null &&
    compare(selection[0], { line, column }) <= 0 &&
    compare({ line, column }, selection[1]) < 0;
  let segmentIndex = 0;
  let segmentEnd = segments?.[0]?.text.length ?? 0;
  let used = 0;
  let column = 0;
  for (const placed of placeText(text, tabSize)) {
    while (
      segments &&
      segmentIndex < segments.length - 1 &&
      column >= segmentEnd
    )
      segmentEnd += segments[++segmentIndex].text.length;
    const end = placed.start + placed.width;
    if (end > left && placed.start < left + width) {
      const segment = segments?.[segmentIndex];
      const match = matches.find(
        (entry) => column >= entry.start && column < entry.end,
      );
      const atCursor = cursor === column;
      const background = atCursor
        ? colors.cursor
        : selected(column)
          ? colors.selection
          : match
            ? match.current
              ? colors.findCurrent
              : colors.findMatch
            : brackets.includes(column)
              ? colors.bracket
              : options.lineBackground;
      const visible =
        placed.start < left || end > left + width
          ? " ".repeat(
              Math.min(end, left + width) - Math.max(placed.start, left),
            )
          : placed.drawn;
      push({
        text: visible,
        color: atCursor
          ? colors.cursorText
          : (segment?.color ?? options.defaultColor),
        background,
        bold: segment?.bold,
        italic: segment?.italic,
        underline: segment?.underline,
      });
      used += Math.min(end, left + width) - Math.max(placed.start, left);
    }
    column += placed.source.length;
    if (end >= left + width) break;
  }
  const lineEnd = text.length;
  if (used < width) {
    const endCell = placeText(text, tabSize).reduce(
      (total, placed) => total + placed.width,
      0,
    );
    if (endCell >= left) {
      if (cursor === lineEnd) {
        push({
          text: " ",
          color: colors.cursorText,
          background: colors.cursor,
        });
        used++;
      } else if (
        selection &&
        compare(selection[0], { line, column: lineEnd }) <= 0 &&
        compare({ line, column: lineEnd }, selection[1]) < 0
      ) {
        push({ text: " ", background: colors.selection });
        used++;
      }
    }
    if (used < width)
      push({
        text: " ".repeat(width - used),
        background: options.lineBackground,
      });
  }
  return pieces;
};

const PieceText = ({ pieces }: { pieces: Piece[] }) => (
  <Text wrap="truncate">
    {pieces.map((piece, index) => (
      <Text
        key={index}
        color={piece.color}
        backgroundColor={piece.background}
        bold={piece.bold}
        italic={piece.italic}
        underline={piece.underline}
      >
        {piece.text}
      </Text>
    ))}
  </Text>
);

/**
 * The code of the active file.
 * @param props.workbench the editor state
 * @param props.tab the tab shown
 * @param props.width cells
 * @param props.height rows
 * @param props.focused the editor has the keyboard
 * @param props.version redraw trigger
 */
export const CodeView = memo(
  ({
    workbench,
    tab,
    width,
    height,
    focused,
  }: {
    workbench: Workbench;
    tab: Tab;
    width: number;
    height: number;
    focused: boolean;
    version: number;
  }) => {
    const { colors: palette } = useTheme();
    const document = tab.document!;
    const { settings } = workbench.config;
    const gutter = workbench.gutterWidth(tab);
    const codeWidth = Math.max(1, width - gutter);
    const selection = document.hasSelection ? document.range() : null;
    const find = workbench.find;
    const bracket =
      focused || !selection ? document.matchingBracket(document.cursor) : null;
    tab.highlight?.request(tab.scrollTop + height + 50);
    const rows: ReactNode[] = [];
    for (let row = 0; row < height; row++) {
      const line = tab.scrollTop + row;
      if (line >= document.lines.length) {
        rows.push(<Text key={row}>{" ".repeat(width)}</Text>);
        continue;
      }
      const current = line === document.cursor.line;
      const lineBackground =
        current && settings.highlightLine && !selection
          ? palette.lineHighlight
          : undefined;
      const number = !settings.lineNumbers
        ? ""
        : settings.relativeLineNumbers && !current
          ? String(Math.abs(line - document.cursor.line))
          : String(line + 1);
      const gutterText = settings.lineNumbers
        ? ` ${number.padStart(gutter - workbench.theme.spacing.gutterPadding - 1)}${" ".repeat(workbench.theme.spacing.gutterPadding)}`
        : " ";
      const matches = find
        ? find.matches.flatMap((match, index) =>
            match.line === line
              ? [
                  {
                    start: match.start,
                    end: match.end,
                    current: index === find.current,
                  },
                ]
              : [],
          )
        : [];
      const pieces = codeRow(
        document.lines[line],
        tab.highlight?.line(line) ?? null,
        line,
        {
          width: codeWidth,
          left: tab.scrollLeft,
          tabSize: document.indentation.size,
          defaultColor: palette.text,
          selection,
          matches,
          brackets: bracket
            ? [bracket[0], bracket[1]]
                .filter((position) => position.line === line)
                .map((position) => position.column)
            : [],
          cursor: focused && current ? document.cursor.column : null,
          lineBackground,
          colors: palette,
        },
      );
      rows.push(
        <Box key={row} height={1}>
          <Text
            color={current ? palette.gutterActive : palette.gutter}
            backgroundColor={lineBackground}
          >
            {gutterText}
          </Text>
          <PieceText pieces={pieces} />
        </Box>,
      );
    }
    const pointAt = (event: LocalMouseEvent) =>
      workbench.positionAt(event.localY, event.localX);
    return (
      <Clickable
        width={width}
        height={height}
        flexDirection="column"
        onPress={(event) => {
          const position = pointAt(event);
          if (!position) return;
          workbench.focus = "editor";
          if (workbench.find) workbench.find.field = null;
          workbench.menu = null;
          if (event.localX < gutter) {
            document.select(
              { line: position.line, column: 0 },
              position.line + 1 < document.lines.length
                ? { line: position.line + 1, column: 0 }
                : {
                    line: position.line,
                    column: document.lines[position.line].length,
                  },
            );
            workbench.changed();
            return;
          }
          document.setCursor(position, event.shift);
          workbench.changed();
          const anchor = document.anchor ?? position;
          return (move) => {
            const target = pointAt(move);
            if (!target) return;
            if (move.localY < 0) workbench.scroll(-1);
            if (move.localY >= height) workbench.scroll(1);
            if (target.line !== anchor.line || target.column !== anchor.column)
              document.select(anchor, target);
            workbench.reveal();
            workbench.changed();
          };
        }}
        onDoubleClick={(event) => {
          const position = pointAt(event);
          if (!position) return;
          document.selectWordAt(position);
          workbench.changed();
        }}
        onRightClick={(event) => {
          workbench.focus = "editor";
          workbench.editorMenu(event.x, event.y);
        }}
        onWheel={(step, event) => {
          if (event.kind === "wheelLeft" || event.kind === "wheelRight")
            workbench.scroll(0, step * 4);
          else workbench.scroll(step * settings.wheelLines);
        }}
      >
        {rows}
      </Clickable>
    );
  },
);
