/**
 * Markdown Preview, as VS Code's (and Markdown Preview Enhanced's): the open
 * Markdown file drawn as a document that follows every edit: headings,
 * paragraphs wrapped to the width, lists, quotes, rules, fenced code on the
 * field ground, and inline bold, italic, code and links. The wheel and the
 * arrow keys scroll it.
 */
import { Text } from "ink";
import { Clickable } from "@/mouse/regions";
import { widthOf } from "@/text";
import type { Tab, Workbench } from "@/workbench";
import { useTheme } from "./theme";

/** A piece of a drawn line. */
interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
}

/** One drawn line and how it looks as a whole. */
interface Line {
  spans: Span[];
  kind: "text" | "heading" | "code" | "quote" | "rule";
  level?: number;
}

const INLINE =
  /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`|!?\[([^\]]+)\]\([^)]*\)/g;

/** @returns the inline pieces of a line of Markdown */
const inline = (source: string): Span[] => {
  const text = source.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  const spans: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index) });
    if (match[2] !== undefined) spans.push({ text: match[2], bold: true });
    else if (match[4] !== undefined)
      spans.push({ text: match[4], italic: true });
    else if (match[5] !== undefined) spans.push({ text: match[5], code: true });
    else spans.push({ text: match[6], link: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
};

/** Wraps pieces into lines of at most `width` cells at spaces, the first line after `lead`, the others after `hang`. */
const wrap = (
  spans: Span[],
  width: number,
  lead: string,
  hang: string,
  kind: Line["kind"],
): Line[] => {
  const lines: Line[] = [];
  let current: Span[] = [{ text: lead }];
  let used = widthOf(lead);
  for (const span of spans)
    for (const word of span.text.split(/(?<= )/)) {
      if (used + widthOf(word) > width && used > widthOf(hang)) {
        lines.push({ spans: current, kind });
        current = [{ text: hang }];
        used = widthOf(hang);
      }
      current.push({ ...span, text: word });
      used += widthOf(word);
    }
  lines.push({ spans: current, kind });
  return lines;
};

/**
 * Lays Markdown out for the terminal.
 * @param source the file's lines
 * @param width cells per line
 * @returns the lines to draw
 */
export const layoutMarkdown = (source: string[], width: number): Line[] => {
  const lines: Line[] = [];
  let fence: string | null = null;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      lines.push(...wrap(inline(paragraph.join(" ")), width, "", "", "text"), {
        spans: [],
        kind: "text",
      });
    paragraph = [];
  };
  for (const raw of source) {
    if (fence !== null) {
      if (raw.trimStart().startsWith(fence)) {
        fence = null;
        lines.push({ spans: [], kind: "text" });
      } else lines.push({ spans: [{ text: ` ${raw}` }], kind: "code" });
      continue;
    }
    const opening = /^\s*(```|~~~)/.exec(raw);
    if (opening) {
      flush();
      fence = opening[1];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      flush();
      lines.push(
        ...wrap(inline(heading[2]), width, "", "", "heading").map((line) => ({
          ...line,
          level: heading[1].length,
        })),
      );
      if (heading[1].length <= 2) lines.push({ spans: [], kind: "rule" });
      lines.push({ spans: [], kind: "text" });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flush();
      lines.push({ spans: [], kind: "rule" }, { spans: [], kind: "text" });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (item) {
      flush();
      const indent = " ".repeat(item[1].length + 2);
      const marker = /\d/.test(item[2]) ? `${item[2]} ` : "• ";
      lines.push(
        ...wrap(
          inline(
            item[3].replace(/^\[( |x)\] /, (_box, mark: string) =>
              mark === "x" ? "☑ " : "☐ ",
            ),
          ),
          width,
          indent + marker,
          indent + "  ",
          "text",
        ),
      );
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      flush();
      lines.push(...wrap(inline(quote[1]), width - 2, "", "", "quote"));
      continue;
    }
    if (!raw.trim()) {
      flush();
      if (lines.at(-1)?.spans.length) lines.push({ spans: [], kind: "text" });
      continue;
    }
    if (raw.trimStart().startsWith("|")) {
      flush();
      lines.push({ spans: [{ text: raw }], kind: "text" });
      continue;
    }
    paragraph.push(raw.trim());
  }
  flush();
  return lines;
};

/**
 * @param props.workbench the editor state
 * @param props.tab the preview's tab; its `source` is the Markdown file's tab
 * @param props.width cells
 * @param props.height rows
 */
export const MarkdownView = ({
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
  const source = tab.source?.document;
  if (!source)
    return (
      <Text color={palette.textMuted}> The Markdown file was closed.</Text>
    );
  const inner = Math.max(10, width - 4);
  const lines = layoutMarkdown(source.lines, inner);
  tab.scrollTop = Math.max(
    0,
    Math.min(tab.scrollTop, Math.max(0, lines.length - height)),
  );
  return (
    <Clickable
      flexDirection="column"
      width={width}
      height={height}
      paddingLeft={2}
      onWheel={(step) => {
        tab.scrollTop = Math.max(0, tab.scrollTop + step * 3);
        workbench.changed();
      }}
    >
      {lines.slice(tab.scrollTop, tab.scrollTop + height).map((line, index) => {
        if (line.kind === "rule")
          return (
            <Text key={index} color={palette.border}>
              {glyphs.rule.repeat(inner)}
            </Text>
          );
        const ground = line.kind === "code" ? palette.field : undefined;
        const used = line.spans.reduce(
          (total, span) => total + widthOf(span.text),
          0,
        );
        return (
          <Text key={index} backgroundColor={ground} wrap="truncate">
            {line.kind === "quote" ? (
              <Text color={palette.border}>{"▎ "}</Text>
            ) : null}
            {line.spans.map((span, spanIndex) => (
              <Text
                key={spanIndex}
                bold={span.bold || line.kind === "heading"}
                italic={span.italic || line.kind === "quote"}
                underline={span.link}
                color={
                  line.kind === "heading"
                    ? line.level === 1
                      ? palette.accent
                      : palette.text
                    : span.link
                      ? palette.accent
                      : span.code || line.kind === "code"
                        ? palette.modified
                        : line.kind === "quote"
                          ? palette.textMuted
                          : palette.text
                }
                backgroundColor={span.code ? palette.field : ground}
              >
                {span.text}
              </Text>
            ))}
            {ground ? " ".repeat(Math.max(0, inner - used)) : null}
          </Text>
        );
      })}
    </Clickable>
  );
};
