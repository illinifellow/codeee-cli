/**
 * Code folding by indentation, as VS Code folds files without a language
 * server: a line folds the lines below it that are indented deeper, up to the
 * closing bracket or tag on its own level, which stays visible.
 */

const indentOf = (text: string) =>
  /^[ \t]*/.exec(text)![0].replace(/\t/g, "    ").length;

/**
 * @param lines the file's lines
 * @param start a line
 * @returns the last line the fold of `start` hides, or `null` when nothing below is indented deeper
 */
export const foldEnd = (lines: string[], start: number): number | null => {
  if (!lines[start]?.trim()) return null;
  const indent = indentOf(lines[start]);
  let end = start;
  for (let line = start + 1; line < lines.length; line++) {
    if (!lines[line].trim()) continue;
    if (indentOf(lines[line]) <= indent) break;
    end = line;
  }
  return end > start ? end : null;
};

/**
 * @param lines the file's lines
 * @param folds the folded lines
 * @returns the lines left on screen, in order
 */
export const visibleLines = (lines: string[], folds: Set<number>) => {
  const visible: number[] = [];
  for (let line = 0; line < lines.length; line++) {
    visible.push(line);
    if (folds.has(line)) line = foldEnd(lines, line) ?? line;
  }
  return visible;
};

/**
 * @param lines the file's lines
 * @param folds the folded lines
 * @param line a line
 * @returns the folded lines whose folds hide `line`
 */
export const foldsHiding = (
  lines: string[],
  folds: Set<number>,
  line: number,
) =>
  [...folds].filter(
    (start) => start < line && (foldEnd(lines, start) ?? start) >= line,
  );
