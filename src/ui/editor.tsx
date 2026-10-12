/**
 * The code area: line numbers, highlighted code scrolled both ways, the
 * current line, the selection, find matches, the bracket matching the one at
 * the cursor, and the cursor itself, drawn cell by cell from the document and
 * its highlighting. Clicks place the cursor, drags select, double clicks select
 * a word, a click in the line numbers selects the line, the wheel scrolls.
 */
import { Box, Text } from "ink";
import { memo, type ReactNode } from "react";
import {
  cellOf,
  eachBracket,
  indentOf,
  type Document,
  type Position,
} from "@/buffer";
import type { Segment } from "@/highlight";
import { Clickable, type LocalMouseEvent } from "@/mouse/regions";
import { fit, placeText, widthOf } from "@/text";
import type { Tab, Workbench } from "@/workbench";
import { stickyLines } from "@/symbols";
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

/** Colour literals Color Highlight marks: hex in 3, 4, 6 or 8 digits, and `rgb()` / `rgba()`. */
const COLOR_LITERAL =
  /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z])|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*[\d.]+\s*)?\)/gi;

/**
 * @param text one line
 * @returns its colour literals with the colour each names, as `#rrggbb`
 */
export const colorSwatches = (text: string) => {
  const swatches: { start: number; end: number; color: string }[] = [];
  for (const match of text.matchAll(COLOR_LITERAL)) {
    const literal = match[0];
    let color: string;
    if (literal.startsWith("#")) {
      const digits = literal.slice(1);
      color =
        digits.length <= 4
          ? `#${[...digits.slice(0, 3)].map((digit) => digit + digit).join("")}`
          : `#${digits.slice(0, 6)}`;
    } else {
      const [red, green, blue] = literal.match(/\d+/g)!.map(Number);
      if ([red, green, blue].some((channel) => channel > 255)) continue;
      color = `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    }
    swatches.push({
      start: match.index,
      end: match.index + literal.length,
      color: color.toLowerCase(),
    });
  }
  return swatches;
};

/** @returns black or white, whichever reads on the colour */
const contrastOn = (color: string) => {
  const [red, green, blue] = [1, 3, 5].map(
    (index) => parseInt(color.slice(index, index + 2), 16) / 255,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.5
    ? "#000000"
    : "#ffffff";
};

/** Cells the minimap takes, and the narrowest editor that shows one. */
const MINIMAP_CELLS = 10;
const MINIMAP_MIN_EDITOR = 60;

/** Braille dots by row (0-3) and column (0-1) within a cell. */
const BRAILLE_DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/** Characters of code one minimap dot stands for, sideways. */
const CHARACTERS_PER_DOT = 2;

/**
 * Draws the minimap as VS Code's: four code lines per row in braille dots, a dot wherever code has a character; the
 * mapped stretch follows the scroll so the viewport is always on it.
 * @returns each row's text, whether a row lies in the viewport, and the line a row stands for
 */
const minimap = (
  lines: string[],
  scrollTop: number,
  height: number,
  cells: number,
  tabSize: number,
) => {
  const span = height * 4;
  const first =
    lines.length <= span
      ? 0
      : Math.round(
          ((lines.length - span) * scrollTop) /
            Math.max(1, lines.length - height),
        );
  const rows: string[] = [];
  for (let row = 0; row < height; row++) {
    const codes = new Array(cells).fill(0);
    for (let dotRow = 0; dotRow < 4; dotRow++) {
      const text = lines[first + row * 4 + dotRow];
      if (text === undefined) continue;
      const expanded = text.replace(/\t/g, " ".repeat(tabSize));
      for (let cell = 0; cell < cells; cell++)
        for (let dotColumn = 0; dotColumn < 2; dotColumn++) {
          const start = (cell * 2 + dotColumn) * CHARACTERS_PER_DOT;
          if (expanded.slice(start, start + CHARACTERS_PER_DOT).trim())
            codes[cell] |= BRAILLE_DOTS[dotRow][dotColumn];
        }
    }
    rows.push(
      codes
        .map((code) => (code ? String.fromCharCode(0x2800 + code) : " "))
        .join(""),
    );
  }
  const lineAt = (row: number) => first + Math.max(0, row) * 4;
  return {
    rows,
    lineAt,
    viewport: (row: number) =>
      lineAt(row) + 3 >= scrollTop && lineAt(row) < scrollTop + height,
  };
};

/** @returns each bracket's colour by its nesting depth, for one line */
const bracketColorsOf = (
  document: Document,
  line: number,
  colors: string[],
) => {
  const result = new Map<number, string>();
  let depth = document.depthAt(line);
  eachBracket(document.lines[line], (column, opens) => {
    if (!opens) depth = Math.max(0, depth - 1);
    result.set(column, colors[depth % colors.length]);
    if (opens) depth++;
  });
  return result;
};

/**
 * @returns the cells of a line's indent guides: every indent stop inside its leading blanks; a blank line takes the
 *   guides of the nearest non-blank line above, so guides run through empty lines
 */
const guideCells = (
  text: string,
  size: number,
  line: number,
  document: Document,
) => {
  let source = text;
  for (let above = line; !source.trim() && above > 0; )
    source = document.lines[--above];
  const indent = cellOf(indentOf(source), indentOf(source).length, size);
  const limit = text.trim()
    ? cellOf(indentOf(text), indentOf(text).length, size)
    : indent;
  const cells: number[] = [];
  for (let cell = 0; cell + size <= Math.min(indent, limit); cell += size)
    cells.push(cell);
  return cells;
};

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
    /** Ranges ESLint reported on the line, drawn underlined. */
    underlines: { start: number; end: number }[];
    /** Colours of brackets by column, by nesting depth. */
    bracketColors: Map<number, string>;
    /** Cells where indent guides are drawn, inside the leading blanks. */
    guides: number[];
    guide: { glyph: string; color: string };
    /** Colour literals of the line, each drawn on its own colour. */
    swatches: { start: number; end: number; color: string }[];
    /** Text drawn after the line's end in the given colour, as the current line blame. */
    after?: { text: string; color: string };
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
      const swatch = options.swatches.find(
        (entry) => column >= entry.start && column < entry.end,
      );
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
              : (swatch?.color ?? options.lineBackground);
      const guide =
        placed.source === " " &&
        options.guides.includes(placed.start) &&
        !atCursor;
      const visible = guide
        ? options.guide.glyph
        : placed.start < left || end > left + width
          ? " ".repeat(
              Math.min(end, left + width) - Math.max(placed.start, left),
            )
          : placed.drawn;
      push({
        text: visible,
        color: atCursor
          ? colors.cursorText
          : swatch && background === swatch.color
            ? contrastOn(swatch.color)
            : guide
              ? options.guide.color
              : (options.bracketColors.get(column) ??
                segment?.color ??
                options.defaultColor),
        background,
        bold: segment?.bold,
        italic: segment?.italic,
        underline:
          segment?.underline ||
          options.underlines.some(
            (range) => column >= range.start && column < range.end,
          ),
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
    if (options.after && endCell >= left && width - used > 4) {
      const text = fit(`   ${options.after.text}`, width - used).trimEnd();
      push({
        text,
        color: options.after.color,
        background: options.lineBackground,
        italic: true,
      });
      used += widthOf(text);
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
    const { colors: palette, glyphs } = useTheme();
    const document = tab.document!;
    const { settings } = workbench.config;
    const gutter = workbench.gutterWidth(tab);
    const mapWidth =
      settings.minimap && width >= MINIMAP_MIN_EDITOR ? MINIMAP_CELLS : 0;
    const codeWidth = Math.max(1, width - gutter - mapWidth);
    const map = mapWidth
      ? minimap(
          document.lines,
          tab.scrollTop,
          height,
          mapWidth,
          document.indentation.size,
        )
      : null;
    const selection = document.hasSelection ? document.range() : null;
    const find = workbench.find;
    const bracket =
      focused || !selection ? document.matchingBracket(document.cursor) : null;
    tab.highlight?.request(tab.scrollTop + height + 50);
    if (focused) workbench.requestBlame();
    const blame = workbench.blame;
    const sticky = settings.stickyScroll
      ? stickyLines(
          document.lines,
          tab.scrollTop,
          Math.max(0, Math.floor(height / 3)),
        )
      : [];
    const rows: ReactNode[] = [];
    for (let row = 0; row < height; row++) {
      const pinned = row < sticky.length;
      const line = pinned ? sticky[row] : tab.scrollTop + row;
      if (line >= document.lines.length) {
        rows.push(
          <Text key={row}>
            {" ".repeat(width - mapWidth)}
            {map ? (
              <Text
                color={palette.textMuted}
                backgroundColor={
                  map.viewport(row) ? palette.lineHighlight : undefined
                }
              >
                {map.rows[row]}
              </Text>
            ) : null}
          </Text>,
        );
        continue;
      }
      const current = line === document.cursor.line && !pinned;
      const problems = (tab.diagnostics ?? []).filter(
        (problem) => problem.line <= line && problem.endLine >= line,
      );
      const lineBackground = pinned
        ? palette.header
        : current && settings.highlightLine && !selection
          ? palette.lineHighlight
          : undefined;
      const number = !settings.lineNumbers
        ? ""
        : settings.relativeLineNumbers && !current
          ? String(Math.abs(line - document.cursor.line))
          : String(line + 1);
      const change = tab.changes?.get(line);
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
          bracketColors: settings.bracketPairColorization
            ? bracketColorsOf(document, line, palette.brackets)
            : new Map(),
          guides: settings.guides
            ? guideCells(
                document.lines[line],
                document.indentation.size,
                line,
                document,
              )
            : [],
          guide: { glyph: glyphs.guide, color: palette.guide },
          swatches: settings.colorDecorators
            ? colorSwatches(document.lines[line])
            : [],
          underlines: problems.map((problem) => ({
            start: problem.line === line ? problem.start : 0,
            end:
              problem.endLine === line
                ? Math.max(problem.end, problem.start + 1)
                : document.lines[line].length,
          })),
          after: problems.length
            ? {
                text: `${problems[0].message}${problems.length > 1 ? ` (+${problems.length - 1})` : ""}`,
                color: problems.some((problem) => problem.severity === "error")
                  ? palette.danger
                  : palette.warning,
              }
            : current &&
                blame?.text &&
                blame.line === line &&
                blame.path === tab.path
              ? { text: blame.text, color: palette.gutter }
              : undefined,
          colors: palette,
        },
      );
      rows.push(
        <Box key={row} height={1}>
          <Text
            color={current ? palette.gutterActive : palette.gutter}
            backgroundColor={lineBackground}
          >
            {gutterText.slice(0, -1)}
          </Text>
          <Text
            color={
              change === "added"
                ? palette.added
                : change === "deleted"
                  ? palette.danger
                  : palette.modified
            }
            backgroundColor={lineBackground}
          >
            {change ? (change === "deleted" ? "▔" : "▎") : gutterText.slice(-1)}
          </Text>
          <PieceText pieces={pieces} />
          {map ? (
            <Text
              color={palette.textMuted}
              backgroundColor={
                map.viewport(row) ? palette.lineHighlight : undefined
              }
            >
              {map.rows[row]}
            </Text>
          ) : null}
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
          if (event.localY < sticky.length) {
            document.setCursor({ line: sticky[event.localY], column: 0 });
            workbench.focus = "editor";
            workbench.reveal(true);
            workbench.changed();
            return;
          }
          if (map && event.localX >= width - mapWidth) {
            const scrollTo = (localY: number) => {
              tab.scrollTop = Math.max(
                0,
                Math.min(
                  document.lines.length - 1,
                  map.lineAt(localY) - Math.floor(height / 2),
                ),
              );
              workbench.changed();
            };
            scrollTo(event.localY);
            return (move) => scrollTo(move.localY);
          }
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
