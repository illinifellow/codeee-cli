/**
 * The Search view of the side bar, as VS Code's: the search field with its
 * case, whole-word and regular-expression toggles, the replace field with
 * Replace All, the files to include and exclude, and the results grouped by
 * file with each match's line and the match itself highlighted. A click on a
 * match opens it with the match selected; a click on a file folds it.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { languageOf } from "@/languages";
import { Clickable } from "@/mouse/regions";
import { shownPath } from "@/search";
import { fit, widthOf } from "@/text";
import type { Workbench } from "@/workbench";
import { FieldText } from "./index";
import { useTheme } from "./theme";

/**
 * @param props.workbench the editor state
 * @param props.width cells
 * @param props.height rows
 */
export const SearchView = ({
  workbench,
  width,
  height,
}: {
  workbench: Workbench;
  width: number;
  height: number;
  version: number;
}) => {
  const { colors: palette, glyphs } = useTheme();
  const view = workbench.search;
  const focused = workbench.focus === "search";
  const rows = workbench.searchRows();
  const fieldWidth = Math.max(4, width - 12);
  const toggle = (label: string, on: boolean, run: () => void) => (
    <Clickable onClick={run}>
      <Text color={on ? palette.accent : palette.textMuted} bold={on}>
        {` ${label}`}
      </Text>
    </Clickable>
  );
  const focusField = (name: NonNullable<typeof view.field>) => () => {
    view.field = name;
    workbench.focus = "search";
    workbench.changed();
  };
  const header: ReactNode[] = [
    <Text key="title" color={palette.textMuted}>
      {fit(" SEARCH", width)}
    </Text>,
    <Box key="query" height={1} width={width}>
      <Clickable
        onClick={() => {
          view.replacing = !view.replacing;
          workbench.changed();
        }}
      >
        <Text color={palette.textMuted}>{view.replacing ? "▾ " : "▸ "}</Text>
      </Clickable>
      <Clickable onClick={focusField("query")}>
        <FieldText
          state={view.query}
          width={fieldWidth}
          focused={focused && view.field === "query"}
          placeholder="Search"
        />
      </Clickable>
      {toggle(glyphs.caseSensitive, view.options.caseSensitive, () =>
        workbench.toggleSearchOption("caseSensitive"),
      )}
      {toggle(glyphs.wholeWord, view.options.wholeWord, () =>
        workbench.toggleSearchOption("wholeWord"),
      )}
      {toggle(glyphs.regex, view.options.regex, () =>
        workbench.toggleSearchOption("regex"),
      )}
    </Box>,
  ];
  if (view.replacing)
    header.push(
      <Box key="replace" height={1} width={width}>
        <Text>{"  "}</Text>
        <Clickable onClick={focusField("replacement")}>
          <FieldText
            state={view.replacement}
            width={fieldWidth}
            focused={focused && view.field === "replacement"}
            placeholder="Replace"
          />
        </Clickable>
        <Clickable onClick={() => workbench.confirmReplaceAll()}>
          <Text color={palette.text}>{` ${glyphs.replaceAll}`}</Text>
        </Clickable>
      </Box>,
    );
  header.push(
    <Clickable
      key="details"
      height={1}
      onClick={() => {
        view.details = !view.details;
        workbench.changed();
      }}
    >
      <Text color={palette.textMuted}>
        {fit(`  ${view.details ? "▾" : "▸"} files to include / exclude`, width)}
      </Text>
    </Clickable>,
  );
  if (view.details)
    header.push(
      <Box key="include" height={1} width={width}>
        <Text>{"  "}</Text>
        <Clickable onClick={focusField("include")}>
          <FieldText
            state={view.include}
            width={width - 4}
            focused={focused && view.field === "include"}
            placeholder="files to include, e.g. src/**, *.ts"
          />
        </Clickable>
      </Box>,
      <Box key="exclude" height={1} width={width}>
        <Text>{"  "}</Text>
        <Clickable onClick={focusField("exclude")}>
          <FieldText
            state={view.exclude}
            width={width - 4}
            focused={focused && view.field === "exclude"}
            placeholder="files to exclude"
          />
        </Clickable>
      </Box>,
    );
  const total = view.results.reduce(
    (count, result) => count + result.matches.length,
    0,
  );
  const summary = view.error
    ? view.error
    : view.running
      ? "Searching…"
      : view.query.value
        ? total
          ? `${total} result${total === 1 ? "" : "s"} in ${view.results.length} file${view.results.length === 1 ? "" : "s"}`
          : "No results found. Review your settings for configured exclusions."
        : "";
  header.push(
    <Text key="summary" color={view.error ? palette.danger : palette.textMuted}>
      {fit(summary ? ` ${summary}` : "", width)}
    </Text>,
  );
  const visible = Math.max(1, height - header.length);
  if (view.cursor < view.top) view.top = view.cursor;
  if (view.cursor >= view.top + visible) view.top = view.cursor - visible + 1;
  view.top = Math.max(
    0,
    Math.min(view.top, Math.max(0, rows.length - visible)),
  );
  const lines = rows.slice(view.top, view.top + visible).map((row, offset) => {
    const index = view.top + offset;
    const selected = focused && !view.field && index === view.cursor;
    const background = selected ? palette.selection : undefined;
    if (row.kind === "file") {
      const path = shownPath(workbench.root, row.result.path);
      const name = path.slice(path.lastIndexOf("/") + 1);
      const folder = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : "";
      const icon = workbench.icons.file(name, languageOf(row.result.path));
      const count = ` ${row.result.matches.length} `;
      const room = Math.max(1, width - 5 - widthOf(name) - widthOf(count));
      return (
        <Clickable
          key={`f${row.result.path}`}
          height={1}
          width={width}
          onClick={() => workbench.openSearchRow(index, true)}
          onRightClick={(event) =>
            workbench.searchMenu(index, event.x, event.y)
          }
        >
          <Text backgroundColor={background}>
            <Text color={palette.textMuted}>
              {view.collapsed.has(row.result.path) ? " ▸" : " ▾"}
            </Text>
            <Text color={icon.color ?? palette.icon}>{` ${icon.glyph} `}</Text>
            <Text color={palette.text}>
              {fit(name, Math.min(widthOf(name), width - 6 - widthOf(count)))}
            </Text>
            <Text color={palette.textMuted}>
              {fit(folder ? ` ${folder}` : "", Math.max(0, room - 1))}
            </Text>
            <Text
              color={palette.accentText}
              backgroundColor={palette.textMuted}
            >
              {count}
            </Text>
          </Text>
        </Clickable>
      );
    }
    const { match } = row;
    const lead = Math.max(0, match.start - 12);
    const before = match.text.slice(lead, match.start).replace(/^\s+/, "");
    const hit = match.text.slice(match.start, match.end);
    const after = match.text.slice(match.end);
    const room = width - 6;
    const shownBefore = fit(before, Math.min(widthOf(before), room));
    const shownHit = fit(
      hit,
      Math.min(widthOf(hit), Math.max(1, room - widthOf(shownBefore))),
    );
    const rest = Math.max(0, room - widthOf(shownBefore) - widthOf(shownHit));
    return (
      <Clickable
        key={`m${row.result.path}:${match.line}:${match.start}`}
        height={1}
        width={width}
        onClick={() => workbench.openSearchRow(index)}
        onRightClick={(event) => workbench.searchMenu(index, event.x, event.y)}
      >
        <Text backgroundColor={background}>
          <Text>{"     "}</Text>
          <Text color={palette.textMuted}>{lead > 0 ? "…" : " "}</Text>
          <Text color={palette.text}>{shownBefore}</Text>
          <Text
            backgroundColor={
              view.replacing && view.replacement.value
                ? palette.danger
                : palette.findCurrent
            }
            color={palette.text}
            strikethrough={view.replacing && Boolean(view.replacement.value)}
          >
            {shownHit}
          </Text>
          {view.replacing && view.replacement.value ? (
            <Text backgroundColor={palette.added} color={palette.accentText}>
              {fit(
                view.replacement.value,
                Math.min(widthOf(view.replacement.value), rest),
              )}
            </Text>
          ) : null}
          <Text color={palette.text}>
            {fit(
              after,
              Math.max(
                0,
                rest - (view.replacing ? widthOf(view.replacement.value) : 0),
              ),
            )}
          </Text>
        </Text>
      </Clickable>
    );
  });
  return (
    <Box flexDirection="column" width={width} height={height}>
      {header}
      <Clickable
        flexDirection="column"
        width={width}
        height={visible}
        onWheel={(step) => {
          view.top = Math.max(
            0,
            Math.min(rows.length - visible, view.top + step * 3),
          );
          view.cursor = Math.max(
            view.top,
            Math.min(view.cursor, view.top + visible - 1),
          );
          workbench.changed();
        }}
      >
        {lines}
      </Clickable>
    </Box>
  );
};
