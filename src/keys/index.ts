/**
 * Keyboard input as the terminal sends it, turned into key events: escape
 * sequences for arrows and function keys with their Shift, Alt and Ctrl
 * modifiers (xterm, SS3 and CSI u forms), control characters, Alt as an Esc
 * prefix, bracketed paste, and runs of typed text. Each event has a canonical
 * name such as `ctrl+s` or `shift+alt+left` that the key bindings are written in.
 */
import { EventEmitter } from "node:events";
import { useEffect, useRef } from "react";

/** One key press, or a pasted or typed run of text. */
export interface KeyEvent {
  /** `up`, `pagedown`, `f3`, `enter`, `tab`, `backspace`, `escape`, a letter or symbol for Ctrl and Alt chords, `text`, `paste`. */
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** What to insert, for `text` and `paste`. */
  text?: string;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Final characters of `CSI … X` sequences. */
const CSI_FINALS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
  Z: "tab",
};

/** Numbers of `CSI n ~` sequences. */
const TILDE_KEYS: Record<string, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

/** Control characters that are keys of their own rather than Ctrl with a letter. */
const CONTROL_KEYS: Record<string, string> = {
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x7f": "backspace",
  "\x08": "backspace",
  "\x1b": "escape",
};

/** Ctrl with a symbol: the character each sends. */
const CONTROL_SYMBOLS: Record<string, string> = {
  "\x00": "space",
  "\x1c": "\\",
  "\x1d": "]",
  "\x1e": "^",
  "\x1f": "/",
};

const CSI = /^\x1b\[([\d;:]*)([A-Za-z~u])/;
const SS3 = /^\x1bO([A-Za-z])/;

const key = (
  name: string,
  modifiers: Partial<Pick<KeyEvent, "ctrl" | "alt" | "shift">> = {},
  text?: string,
): KeyEvent => ({
  name,
  ctrl: Boolean(modifiers.ctrl),
  alt: Boolean(modifiers.alt),
  shift: Boolean(modifiers.shift),
  ...(text === undefined ? {} : { text }),
});

/** @returns the modifiers of an xterm modifier parameter (1 + shift 1, alt 2, ctrl 4) */
const modifiersOf = (parameter: string | undefined) => {
  const bits = Math.max(0, (Number.parseInt(parameter ?? "1", 10) || 1) - 1);
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  };
};

/**
 * Reads one `CSI` sequence.
 * @returns the key, or `null` for a sequence that names no key codeee knows (it is dropped)
 */
const fromCsi = (parameters: string, final: string): KeyEvent | null => {
  const parts = parameters.split(";");
  if (final === "u") {
    const code = Number.parseInt(parts[0], 10);
    const modifiers = modifiersOf(parts[1]);
    const named = CONTROL_KEYS[String.fromCharCode(code)];
    if (named) return key(named, modifiers);
    return key(String.fromCharCode(code).toLowerCase(), modifiers);
  }
  if (final === "~") {
    const name = TILDE_KEYS[parts[0]];
    if (parts[0] === "27" && parts[2])
      return fromCsi(`${parts[2]};${parts[1]}`, "u");
    return name ? key(name, modifiersOf(parts[1])) : null;
  }
  const name = CSI_FINALS[final];
  if (!name) return null;
  return key(name, final === "Z" ? { shift: true } : modifiersOf(parts[1]));
};

/**
 * Splits terminal input into key events.
 * @param input what arrived from the terminal, mouse reports already taken out
 * @returns the events in order; typed text runs (several characters arriving at once) come as one `text` event,
 *   bracketed paste as one `paste` event with line breaks normalised to `\n`
 */
export const parseKeys = (input: string): KeyEvent[] => {
  const events: KeyEvent[] = [];
  let rest = input;
  let text = "";
  const flush = () => {
    if (text) events.push(key("text", {}, text));
    text = "";
  };
  while (rest) {
    if (rest.startsWith(PASTE_START)) {
      flush();
      const end = rest.indexOf(PASTE_END);
      const body =
        end < 0
          ? rest.slice(PASTE_START.length)
          : rest.slice(PASTE_START.length, end);
      events.push(key("paste", {}, body.replace(/\r\n?/g, "\n")));
      rest = end < 0 ? "" : rest.slice(end + PASTE_END.length);
      continue;
    }
    const csi = CSI.exec(rest);
    if (csi) {
      flush();
      const event = fromCsi(csi[1], csi[2]);
      if (event) events.push(event);
      rest = rest.slice(csi[0].length);
      continue;
    }
    const ss3 = SS3.exec(rest);
    if (ss3) {
      flush();
      const name = CSI_FINALS[ss3[1]];
      if (name) events.push(key(name));
      rest = rest.slice(ss3[0].length);
      continue;
    }
    if (rest.startsWith("\x1b") && rest.length > 1) {
      flush();
      const tail = rest.slice(1);
      const sequence = (CSI.exec(tail) ?? SS3.exec(tail))?.[0];
      if (!sequence && tail.startsWith("\x1b")) {
        events.push(key("escape"));
        rest = tail;
        continue;
      }
      const chord = sequence ?? [...tail][0];
      const inner = parseKeys(chord);
      rest = tail.slice(chord.length);
      for (const event of inner)
        events.push(
          event.name === "text"
            ? key(event.text!.toLowerCase(), {
                alt: true,
                shift: event.text !== event.text!.toLowerCase(),
              })
            : { ...event, alt: true },
        );
      continue;
    }
    const [character] = rest;
    rest = rest.slice(character.length);
    if (CONTROL_KEYS[character]) {
      flush();
      events.push(
        key(
          CONTROL_KEYS[character],
          character === "\x08" ? { ctrl: true } : {},
        ),
      );
      continue;
    }
    if (CONTROL_SYMBOLS[character]) {
      flush();
      events.push(key(CONTROL_SYMBOLS[character], { ctrl: true }));
      continue;
    }
    const code = character.charCodeAt(0);
    if (code < 0x20) {
      flush();
      events.push(key(String.fromCharCode(code + 96), { ctrl: true }));
      continue;
    }
    const nextCode = rest.codePointAt(0);
    text += character;
    if (nextCode !== undefined && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
      text += rest[0];
      rest = rest.slice(1);
    }
  }
  flush();
  return events;
};

/**
 * @param event a key event
 * @returns its binding name, modifiers in the order ctrl, alt, shift: `ctrl+s`, `alt+up`, `ctrl+shift+left`; a
 *   single typed character gives the character itself
 */
export const bindingOf = (event: KeyEvent) => {
  const name =
    event.name === "text" && event.text && [...event.text].length === 1
      ? event.text
      : event.name;
  return [
    event.ctrl && "ctrl",
    event.alt && "alt",
    event.shift && "shift",
    name,
  ]
    .filter(Boolean)
    .join("+");
};

/** Key events for the screen: `startMouse` feeds the keyboard part of the input here, components listen with `useKeys`. */
export const keyboard = new EventEmitter();

/**
 * Feeds terminal input to the listeners.
 * @param input keyboard input, mouse reports already taken out
 */
export const dispatchKeys = (input: string) => {
  for (const event of parseKeys(input)) keyboard.emit("key", event);
};

/**
 * Listens to keys while the component is mounted.
 * @param handler receives every key event; the latest handler is called, so it may close over fresh state
 * @param active listen only while true
 */
export const useKeys = (handler: (event: KeyEvent) => void, active = true) => {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyEvent) => latest.current(event);
    keyboard.on("key", listener);
    return () => void keyboard.off("key", listener);
  }, [active]);
};

/** What macOS types for Option with each letter on the US layout, lower case then with Shift, for terminals that send Option as text. */
const OPTION_LETTERS: Record<string, string> = Object.fromEntries([
  ..."å∫ç∂´ƒ©˙ˆ∆˚¬µ˜øπœ®ß†¨√∑≈¥Ω"
    .split("")
    .map((character, index) => [
      character,
      `alt+${String.fromCharCode(97 + index)}`,
    ]),
  ..."ÅıÇÎ´Ï˝ÓˆÔÒÂ˜ØˆØ∏Œ‰Íˇ¨◊„˛Á¸"
    .split("")
    .map((character, index) => [
      character,
      `alt+shift+${String.fromCharCode(97 + index)}`,
    ]),
]);

/**
 * @param event a key event
 * @returns the Alt chord a typed Option character stands for (`√` is `alt+v`), or `null`
 */
export const optionChord = (event: KeyEvent) =>
  event.name === "text" && event.text && [...event.text].length === 1
    ? (OPTION_LETTERS[event.text] ?? OPTION_SYMBOLS[event.text] ?? null)
    : null;

/** Option with symbols on the US layout. */
const OPTION_SYMBOLS: Record<string, string> = {
  "–": "alt+-",
  "≠": "alt+=",
  "“": "alt+[",
  "‘": "alt+]",
};
