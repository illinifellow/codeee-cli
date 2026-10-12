/**
 * The first screen: asks which folder to open, prefilled with the current
 * directory, with recent folders below. Tab completes a
 * folder name, ↑ ↓ or a click pick a recent folder, a double click or Enter
 * starts, Esc quits.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Box, Text, useApp } from "ink";
import { useState } from "react";
import { Clickable } from "@/mouse/regions";
import { expandPath } from "@/files";
import { useKeys } from "@/keys";
import { fit } from "@/text";
import { useTheme } from "./theme";

/**
 * @param typed the path typed so far
 * @returns the path completed to the longest folder name the matches share, with a slash when one folder matches
 */
const complete = (typed: string) => {
  const path = expandPath(typed);
  const folder = typed.endsWith("/") ? path : dirname(path);
  const prefix = typed.endsWith("/") ? "" : basename(path);
  try {
    const matches = readdirSync(folder, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith(prefix) &&
          (prefix.startsWith(".") || !entry.name.startsWith(".")),
      )
      .map((entry) => entry.name);
    if (!matches.length) return typed;
    let shared = matches[0];
    for (const match of matches)
      while (!match.startsWith(shared)) shared = shared.slice(0, -1);
    const completed = join(folder, shared);
    return matches.length === 1 ? `${completed}/` : completed;
  } catch {
    return typed;
  }
};

/**
 * @param props.initial folder the input starts with
 * @param props.recent recently opened folders, newest first, as many as `limits.recentFolders` keeps
 * @param props.onPick called with the chosen folder once it exists
 * @param props.width screen width in cells
 */
export const FolderPicker = ({
  initial,
  recent,
  onPick,
  width,
}: {
  initial: string;
  recent: string[];
  onPick: (folder: string) => void;
  width: number;
}) => {
  const { colors: palette, glyphs, spacing, surface } = useTheme();
  const { exit } = useApp();
  const [value, setValue] = useState(initial);
  const [cursor, setCursor] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const choices = recent.filter((folder) => folder !== initial);
  useKeys((key) => {
    if (
      key.name === "escape" ||
      (key.ctrl && (key.name === "c" || key.name === "q"))
    )
      return exit();
    if (key.name === "enter") {
      const folder = expandPath(value);
      if (!existsSync(folder) || !statSync(folder).isDirectory())
        return setError(`${folder} is not a folder`);
      return onPick(folder);
    }
    if (key.name === "tab") return setValue(complete(value));
    if (key.name === "up" || key.name === "down") {
      const next = Math.max(
        -1,
        Math.min(choices.length - 1, cursor + (key.name === "down" ? 1 : -1)),
      );
      setCursor(next);
      setValue(next === -1 ? initial : choices[next]);
      return;
    }
    if (key.name === "backspace")
      return setValue(
        value.slice(
          0,
          key.ctrl || key.alt ? value.replace(/[^/]*\/?$/, "").length : -1,
        ),
      );
    if ((key.name === "text" || key.name === "paste") && key.text) {
      setError(null);
      setValue(value + key.text.replace(/\n/g, ""));
    }
  });
  const choose = (index: number) => {
    setCursor(index);
    setValue(choices[index]);
    setError(null);
  };
  const boxWidth = Math.min(spacing.pickerWidth, width - 4);
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      width={width}
      minHeight={process.stdout.rows ?? 24}
      backgroundColor={surface}
    >
      <Text color={palette.accent} bold>
        codeee
      </Text>
      <Text color={palette.text}>Which folder should codeee open?</Text>
      <Box
        borderStyle="round"
        borderColor={palette.accent}
        borderBackgroundColor={surface}
        backgroundColor={surface}
        width={boxWidth}
        marginTop={1}
      >
        <Text color={palette.text}>
          {fit(`${value}${glyphs.cursor}`, boxWidth - 2)}
        </Text>
      </Box>
      {error ? (
        <Text color={palette.danger}>
          {glyphs.error} {error}
        </Text>
      ) : null}
      {choices.length ? <Text color={palette.textMuted}>Recent</Text> : null}
      {choices.map((folder, index) => (
        <Clickable
          key={folder}
          height={1}
          onClick={() => choose(index)}
          onDoubleClick={() => onPick(folder)}
        >
          <Text color={index === cursor ? palette.accent : palette.text}>
            {index === cursor ? `${glyphs.pointer} ` : "  "}
            {folder}
          </Text>
        </Clickable>
      ))}
      <Text color={palette.textMuted}>
        {"\n"}enter start · tab complete · ↑↓ or click recent · double-click
        opens · esc quit
      </Text>
    </Box>
  );
};
