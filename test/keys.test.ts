/**
 * Terminal input to key events: a key the parser misreads is a shortcut that
 * does nothing or the wrong thing, or a paste that arrives as keystrokes.
 */
import { describe, expect, it } from "vitest";
import { bindingOf, parseKeys } from "@/keys";

const bindings = (input: string) => parseKeys(input).map(bindingOf);

describe("parseKeys", () => {
  it("reads Ctrl chords, arrows with modifiers and function keys", () => {
    expect(bindings("\x13")).toEqual(["ctrl+s"]);
    expect(bindings("\x1f")).toEqual(["ctrl+/"]);
    expect(bindings("\x1b[1;2D")).toEqual(["shift+left"]);
    expect(bindings("\x1b[1;5C")).toEqual(["ctrl+right"]);
    expect(bindings("\x1b[6;5~")).toEqual(["ctrl+pagedown"]);
    expect(bindings("\x1bOR")).toEqual(["f3"]);
    expect(bindings("\x1b[Z")).toEqual(["shift+tab"]);
  });

  it("reads Alt as an Esc prefix, CSI u chords, and a lone Esc", () => {
    expect(bindings("\x1b\x1b[A")).toEqual(["alt+up"]);
    expect(bindings("\x1bc")).toEqual(["alt+c"]);
    expect(bindings("\x1b[102;4u")).toEqual(["alt+shift+f"]);
    expect(bindings("\x1b")).toEqual(["escape"]);
  });

  it("keeps typed text together and bracketed paste whole, line breaks included", () => {
    expect(parseKeys("héllo")).toEqual([
      { name: "text", ctrl: false, alt: false, shift: false, text: "héllo" },
    ]);
    const [paste] = parseKeys("\x1b[200~a\r\nb\x1b[201~");
    expect(paste.name).toBe("paste");
    expect(paste.text).toBe("a\nb");
  });

  it("splits Enter, Tab and Backspace from the text around them", () => {
    expect(parseKeys("a\rb\t\x7f").map((event) => event.name)).toEqual([
      "text",
      "enter",
      "text",
      "tab",
      "backspace",
    ]);
  });
});
