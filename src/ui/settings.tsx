/**
 * The settings page, after VS Code's Settings editor: the search box with the
 * number of matching settings and the link to the JSON file, the table of
 * contents on the left with counts while searching, and on the right every
 * setting as `Category › Section: Title` with its description and control: a
 * checkbox, a number or text field, a dropdown with descriptions, a list, or a
 * key binding. A modified setting has the accent bar on its left and a reset
 * link; every change is saved at once.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { Clickable } from "@/mouse/regions";
import {
  CATEGORIES,
  categoryCounts,
  choicesOf,
  valueAt,
  type SettingSpec,
} from "@/settings";
import { fit, widthOf } from "@/text";
import type { Workbench } from "@/workbench";
import { FieldText, shortKey } from "./index";
import { useTheme } from "./theme";

/** Wraps text into lines of at most `width` cells, at spaces. */
const wrap = (text: string, width: number) => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && widthOf(`${line} ${word}`) > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
};

/** How a value reads in its control. */
const shown = (value: unknown) =>
  Array.isArray(value) ? value.join(", ") : String(value);

/**
 * @param props.workbench the editor state
 * @param props.width cells
 * @param props.height rows
 */
export const SettingsPage = ({
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
  const view = workbench.settingsView;
  const config = workbench.config;
  const defaults = workbench.defaults();
  const rows = workbench.settingsRows();
  const specs = workbench.settingsSpecs();
  const counts = categoryCounts(view.search.value);
  const tocWidth = width >= 70 ? 24 : 0;
  const listWidth = width - tocWidth - 2;
  const focused = workbench.focus === "settings";
  const searchWidth = Math.max(10, width - 30);
  view.cursor = Math.max(0, Math.min(view.cursor, specs.length - 1));

  const blocks: { key: string; lines: ReactNode[]; spec?: SettingSpec }[] = [];
  let category = "";
  for (const row of rows) {
    if (row.kind === "heading") {
      if (row.level === 1) category = row.text;
      blocks.push({
        key: `h-${row.level}-${row.text}`,
        lines: [
          ...(blocks.length ? [<Text key="gap"> </Text>] : []),
          <Text key="h" bold color={palette.text}>
            {fit(row.level === 1 ? row.text : `${row.text}`, listWidth)}
          </Text>,
        ],
      });
      continue;
    }
    const spec = row.spec;
    const index = specs.indexOf(spec);
    const selected = focused && !view.searching && index === view.cursor;
    const value = valueAt(config, spec.key);
    const modified =
      JSON.stringify(value) !== JSON.stringify(valueAt(defaults, spec.key));
    const bar = (
      <Text
        color={
          modified ? palette.accent : selected ? palette.border : undefined
        }
      >
        {modified || selected ? "▎" : " "}
      </Text>
    );
    const prefix =
      category === "Commonly Used"
        ? `${spec.category} › ${spec.section}: `
        : `${spec.section}: `;
    const title = (
      <Text key="t">
        {bar}
        <Text color={palette.textMuted}>{prefix}</Text>
        <Text bold color={palette.text}>
          {spec.title}
        </Text>
        {modified ? <Text color={palette.textMuted}> (Modified)</Text> : null}
      </Text>
    );
    const lines: ReactNode[] = [<Text key="space"> </Text>, title];
    const describe = (text: string, indent = 1) =>
      wrap(text.replace(/`/g, ""), Math.max(10, listWidth - indent - 1)).map(
        (line, number) => (
          <Text key={`d${number}`}>
            {bar}
            <Text color={palette.textMuted}>
              {" ".repeat(indent - 1)}
              {line}
            </Text>
          </Text>
        ),
      );
    const editing = view.editing?.key === spec.key;
    if (spec.type === "boolean") {
      const [first = "", ...rest] = wrap(
        spec.description,
        Math.max(10, listWidth - 6),
      );
      lines.push(
        <Clickable
          key="c"
          height={1}
          onClick={() => workbench.activateSetting(spec.key)}
        >
          <Text>
            {bar}
            <Text
              color={value ? palette.accent : palette.text}
              backgroundColor={palette.field}
            >
              {value ? ` ${glyphs.checked} ` : "   "}
            </Text>
            <Text color={palette.textMuted}> {first}</Text>
          </Text>
        </Clickable>,
        ...rest.map((line, number) => (
          <Text key={`r${number}`}>
            {bar}
            <Text color={palette.textMuted}>{`    ${line}`}</Text>
          </Text>
        )),
      );
    } else {
      lines.push(...describe(spec.description));
      const controlWidth = Math.min(
        spec.type === "list" ? listWidth - 4 : 36,
        listWidth - 4,
      );
      if (spec.type === "enum") {
        const choices = choicesOf(spec, config);
        lines.push(
          <Clickable
            key="c"
            height={1}
            onClick={() => workbench.activateSetting(spec.key)}
          >
            <Text>
              {bar}
              <Text color={palette.text} backgroundColor={palette.field}>
                {fit(` ${shown(value)}`, controlWidth - 2)}
              </Text>
              <Text color={palette.accent} backgroundColor={palette.field}>
                {glyphs.dropdown}{" "}
              </Text>
            </Text>
          </Clickable>,
        );
        if (view.dropdown?.key === spec.key) {
          choices.forEach((choice, choiceIndex) => {
            const highlighted = choiceIndex === view.dropdown!.cursor;
            lines.push(
              <Clickable
                key={`o${choiceIndex}`}
                height={1}
                onClick={() => {
                  view.dropdown = null;
                  workbench.setSetting(spec.key, choice.value);
                }}
              >
                <Text>
                  {bar}
                  <Text
                    backgroundColor={
                      highlighted ? palette.selection : palette.field
                    }
                    color={palette.text}
                  >
                    {fit(
                      ` ${choice.value === value ? glyphs.checked : " "} ${choice.value}`,
                      controlWidth,
                    )}
                  </Text>
                </Text>
              </Clickable>,
            );
          });
          const description = choices[view.dropdown.cursor]?.description;
          if (description)
            lines.push(
              ...wrap(description, controlWidth - 2).map((line, number) => (
                <Text key={`od${number}`}>
                  {bar}
                  <Text
                    backgroundColor={palette.field}
                    color={palette.textMuted}
                  >
                    {fit(` ${line}`, controlWidth)}
                  </Text>
                </Text>
              )),
            );
        }
      } else if (spec.type === "list") {
        const items = value as string[];
        if (editing)
          lines.push(
            <Text key="c">
              {bar}
              <FieldText
                state={view.editing!.field}
                width={controlWidth}
                focused
              />
            </Text>,
          );
        else {
          items.forEach((item, itemIndex) =>
            lines.push(
              <Text key={`i${itemIndex}`}>
                {bar}
                <Text color={palette.text}>
                  {fit(`  ${item}`, controlWidth)}
                </Text>
              </Text>,
            ),
          );
          lines.push(
            <Clickable
              key="add"
              height={1}
              onClick={() => workbench.activateSetting(spec.key)}
            >
              <Text>
                {bar}
                <Text
                  color={palette.accentText}
                  backgroundColor={palette.accent}
                >
                  {" "}
                  Edit Items{" "}
                </Text>
              </Text>
            </Clickable>,
          );
        }
      } else {
        const text =
          spec.type === "key"
            ? `${shown(value)}   ${shortKey(String(value))}`
            : shown(value);
        lines.push(
          <Clickable
            key="c"
            height={1}
            onClick={() => workbench.activateSetting(spec.key)}
          >
            <Text>
              {bar}
              {editing ? (
                <FieldText
                  state={view.editing!.field}
                  width={controlWidth}
                  focused
                />
              ) : (
                <Text color={palette.text} backgroundColor={palette.field}>
                  {fit(` ${text}`, controlWidth)}
                </Text>
              )}
            </Text>
          </Clickable>,
        );
      }
    }
    if (editing && view.error)
      lines.push(
        <Text key="e">
          {bar}
          <Text color={palette.danger}>
            {glyphs.error} {view.error}
          </Text>
        </Text>,
      );
    if (modified)
      lines.push(
        <Clickable
          key="reset"
          height={1}
          onClick={() => workbench.resetSetting(spec.key)}
        >
          <Text>
            {bar}
            <Text color={palette.accent} underline>
              Reset Setting
            </Text>
            <Text
              color={palette.textMuted}
            >{`  default: ${fit(shown(valueAt(defaults, spec.key)), Math.max(4, listWidth - 30))}`}</Text>
          </Text>
        </Clickable>,
      );
    blocks.push({ key: spec.key, lines, spec });
  }

  const flat: { key: string; node: ReactNode; spec?: SettingSpec }[] =
    blocks.flatMap((block) =>
      block.lines.map((node, line) => ({
        key: `${block.key}-${line}`,
        node,
        spec: block.spec,
      })),
    );
  const listHeight = Math.max(1, height - 3);
  const selectedSpec = specs[view.cursor];
  const firstLine = flat.findIndex((entry) => entry.spec === selectedSpec);
  const lastLine = flat.findLastIndex((entry) => entry.spec === selectedSpec);
  if (!view.searching && selectedSpec) {
    if (firstLine - 1 < view.top) view.top = Math.max(0, firstLine - 2);
    if (lastLine >= view.top + listHeight) view.top = lastLine - listHeight + 1;
  }
  view.top = Math.max(
    0,
    Math.min(view.top, Math.max(0, flat.length - listHeight)),
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} width={width}>
        <Text> </Text>
        <Clickable
          onClick={() => {
            view.searching = true;
            workbench.focus = "settings";
            workbench.changed();
          }}
        >
          <FieldText
            state={view.search}
            width={searchWidth}
            focused={focused && view.searching}
            placeholder="Search settings"
          />
        </Clickable>
        <Text color={palette.textMuted}>
          {` ${view.search.value ? `${specs.length} Settings Found` : ""}`.padEnd(
            20,
          )}
        </Text>
        <Box flexGrow={1} />
        <Clickable onClick={() => workbench.openSettingsJson()}>
          <Text color={palette.accent}>{"{ } JSON "}</Text>
        </Clickable>
      </Box>
      <Box height={1} width={width}>
        <Text> </Text>
        <Text color={palette.text} bold underline>
          User
        </Text>
        <Text
          color={palette.textMuted}
        >{`   ${workbench.userSettingsPath()}`}</Text>
      </Box>
      <Text color={palette.border}>{glyphs.rule.repeat(width)}</Text>
      <Box height={listHeight} width={width}>
        {tocWidth ? (
          <Box flexDirection="column" width={tocWidth}>
            {CATEGORIES.map((entry) => {
              const count = counts.get(entry.name);
              if (view.search.value && !count) return null;
              const active = view.category === entry.name;
              return (
                <Box key={entry.name} flexDirection="column">
                  <Clickable
                    height={1}
                    onClick={() => {
                      view.category = active ? null : entry.name;
                      view.cursor = 0;
                      view.top = 0;
                      workbench.changed();
                    }}
                  >
                    <Text
                      color={active ? palette.accent : palette.text}
                      bold={active}
                    >
                      {fit(
                        ` ${entry.name}${view.search.value && count ? ` (${count})` : ""}`,
                        tocWidth - 1,
                      )}
                    </Text>
                  </Clickable>
                  {!view.search.value &&
                  entry.sections.length &&
                  (active || !view.category)
                    ? entry.sections.map((section) => (
                        <Text key={section} color={palette.textMuted}>
                          {fit(`   ${section}`, tocWidth - 1)}
                        </Text>
                      ))
                    : null}
                </Box>
              );
            })}
          </Box>
        ) : null}
        {tocWidth ? (
          <Text color={palette.border}>
            {`${glyphs.divider}\n`.repeat(listHeight).trimEnd()}
          </Text>
        ) : null}
        <Clickable
          flexDirection="column"
          width={listWidth + 1}
          height={listHeight}
          paddingLeft={1}
          onWheel={(step) => {
            view.top = Math.max(
              0,
              Math.min(flat.length - listHeight, view.top + step * 3),
            );
            workbench.changed();
          }}
        >
          {flat.slice(view.top, view.top + listHeight).map((entry) => (
            <Clickable
              key={entry.key}
              height={1}
              onClick={() => {
                if (!entry.spec) return;
                view.cursor = specs.indexOf(entry.spec);
                view.searching = false;
                workbench.focus = "settings";
                workbench.changed();
              }}
            >
              {entry.node}
            </Clickable>
          ))}
          {!flat.length ? (
            <Text color={palette.textMuted}>No Settings Found</Text>
          ) : null}
        </Clickable>
      </Box>
    </Box>
  );
};
