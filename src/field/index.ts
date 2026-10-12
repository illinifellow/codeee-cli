/**
 * A one-line text field as data: its value and cursor, and how a key changes
 * them. The find widget, Quick Open, dialogs and the settings page all type
 * through it, so every field edits the same way: arrows, Home and End, word
 * moves and deletes with Ctrl or Alt, typing and pasting.
 */
import type { KeyEvent } from "@/keys";
import { graphemes } from "@/text";

/** A field's text and where the cursor is in it (a UTF-16 offset). */
export interface Field {
  value: string;
  cursor: number;
}

/** @returns a field holding `value` with the cursor at its end */
export const field = (value = ""): Field => ({ value, cursor: value.length });

const wordLeft = (value: string, cursor: number) => {
  let index = cursor;
  while (index > 0 && /\s/.test(value[index - 1])) index--;
  while (index > 0 && !/\s/.test(value[index - 1])) index--;
  return index;
};

const wordRight = (value: string, cursor: number) => {
  let index = cursor;
  while (index < value.length && /\s/.test(value[index])) index++;
  while (index < value.length && !/\s/.test(value[index])) index++;
  return index;
};

const previous = (value: string, cursor: number) =>
  cursor - (graphemes(value.slice(0, cursor)).at(-1)?.length ?? 0);

const next = (value: string, cursor: number) =>
  cursor + (graphemes(value.slice(cursor, cursor + 16))[0]?.length ?? 0);

/**
 * Applies a key to a field.
 * @param state the field
 * @param key the key
 * @returns the changed field, or `null` when the key is not one a field handles (Enter, Esc, Tab, ↑ ↓ and chords)
 */
export const editField = (state: Field, key: KeyEvent): Field | null => {
  const { value, cursor } = state;
  const word = key.ctrl || key.alt;
  switch (key.name) {
    case "text":
    case "paste": {
      const text = (key.text ?? "").replace(/\n/g, " ");
      return {
        value: value.slice(0, cursor) + text + value.slice(cursor),
        cursor: cursor + text.length,
      };
    }
    case "backspace": {
      const from = word ? wordLeft(value, cursor) : previous(value, cursor);
      return {
        value: value.slice(0, from) + value.slice(cursor),
        cursor: from,
      };
    }
    case "delete": {
      const to = word ? wordRight(value, cursor) : next(value, cursor);
      return { value: value.slice(0, cursor) + value.slice(to), cursor };
    }
    case "left":
      return {
        value,
        cursor: word ? wordLeft(value, cursor) : previous(value, cursor),
      };
    case "right":
      return {
        value,
        cursor: word ? wordRight(value, cursor) : next(value, cursor),
      };
    case "home":
      return { value, cursor: 0 };
    case "end":
      return { value, cursor: value.length };
    case "u":
      return key.ctrl ? { value: value.slice(cursor), cursor: 0 } : null;
    default:
      return null;
  }
};

/**
 * Splits a field for drawing with a cursor, scrolled so the cursor stays inside the width.
 * @param state the field
 * @param width cells available
 * @returns the text before the cursor, the character under it (a space at the end) and the text after, cut to the width
 */
export const fieldView = (
  state: Field,
  width: number,
): [string, string, string] => {
  const pieces = graphemes(state.value);
  let index = 0;
  let offset = 0;
  while (offset < state.cursor && index < pieces.length)
    offset += pieces[index++].length;
  const start = Math.max(0, index - width + 1);
  const beforeCursor = pieces.slice(start, index).join("");
  const under = pieces[index] ?? " ";
  const after = pieces.slice(index + 1, start + width).join("");
  return [beforeCursor, under, after];
};
