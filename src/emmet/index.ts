/**
 * Emmet abbreviations, as VS Code expands them on Tab in HTML and JSX: tags
 * with classes, ids and attributes, children with `>`, siblings with `+`,
 * climbing with `^`, repetition with `*` and `$` numbering, and `{text}`.
 * Only abbreviations that start with a known HTML element expand, so code
 * such as `user.name` is left alone.
 */

/** HTML elements an abbreviation may start with. */
const ELEMENTS = new Set(
  "a abbr address article aside audio b blockquote body br button canvas caption code col dd details dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input label legend li link main mark meta nav noscript ol optgroup option output p picture pre progress section select small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr u ul video".split(
    " ",
  ),
);

const VOID = new Set([
  "br",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "col",
  "embed",
]);

/** One element of an abbreviation, with its children. */
interface Node {
  tag: string;
  classes: string[];
  id: string;
  attributes: string;
  text: string;
  count: number;
  children: Node[];
}

const ELEMENT =
  /^([a-z][\w:-]*)?((?:[.#][\w$-]+|\[[^\]]*\])*)(?:\{([^}]*)\})?(?:\*(\d+))?/i;

/**
 * Parses an abbreviation.
 * @returns the top-level nodes, or `null` when it is not one
 */
const parse = (abbreviation: string): Node[] | null => {
  const root: Node = {
    tag: "",
    classes: [],
    id: "",
    attributes: "",
    text: "",
    count: 1,
    children: [],
  };
  const stack: Node[] = [root];
  let rest = abbreviation;
  let last: Node | null = null;
  while (rest) {
    const match = ELEMENT.exec(rest);
    if (!match || !match[0]) return null;
    const node: Node = {
      tag: match[1] ?? "div",
      classes: [],
      id: "",
      attributes: "",
      text: match[3] ?? "",
      count: Number(match[4] ?? 1),
      children: [],
    };
    for (const part of match[2].match(/[.#][\w$-]+|\[[^\]]*\]/g) ?? []) {
      if (part.startsWith(".")) node.classes.push(part.slice(1));
      else if (part.startsWith("#")) node.id = part.slice(1);
      else node.attributes += ` ${part.slice(1, -1)}`;
    }
    stack.at(-1)!.children.push(node);
    last = node;
    rest = rest.slice(match[0].length);
    const operator = rest[0];
    if (!operator) break;
    rest = rest.slice(1);
    if (operator === ">") stack.push(last);
    else if (operator === "^") stack.length > 1 && stack.pop();
    else if (operator !== "+") return null;
  }
  return root.children;
};

/**
 * Expands an abbreviation.
 * @param abbreviation what was typed, e.g. `ul>li.item*3`
 * @param options.jsx write `className` instead of `class`
 * @param options.indent the indent of the line it starts on; options.unit one indent level
 * @returns the markup and the offset of the first empty spot for the cursor, or `null` when it is not an abbreviation
 */
export const expandEmmet = (
  abbreviation: string,
  options: { jsx: boolean; indent: string; unit: string },
) => {
  const first = /^[a-z][\w:-]*/i.exec(abbreviation)?.[0]?.toLowerCase();
  if (
    !first ||
    !ELEMENTS.has(first) ||
    !/^[\w.#>+^*$\-[\]="' {}]+$/.test(abbreviation)
  )
    return null;
  const nodes = parse(abbreviation);
  if (!nodes) return null;
  let cursor = -1;
  let out = "";
  const write = (list: Node[], depth: number) => {
    list.forEach((node) => {
      for (let index = 1; index <= node.count; index++) {
        const number = (text: string) =>
          text.replace(/\$+/g, (run) =>
            String(index).padStart(run.length, "0"),
          );
        const pad = options.indent + options.unit.repeat(depth);
        const classes = node.classes.length
          ? ` ${options.jsx ? "className" : "class"}="${number(node.classes.join(" "))}"`
          : "";
        const id = node.id ? ` id="${number(node.id)}"` : "";
        const open = `<${node.tag}${id}${classes}${number(node.attributes)}`;
        if (out) out += `\n${pad}`;
        if (VOID.has(node.tag)) {
          out += `${open}${options.jsx ? " />" : ">"}`;
          continue;
        }
        out += `${open}>`;
        if (node.children.length) {
          write(node.children, depth + 1);
          out += `\n${pad}</${node.tag}>`;
        } else {
          if (!node.text && cursor < 0) cursor = out.length;
          out += `${number(node.text)}</${node.tag}>`;
        }
      }
    });
  };
  write(nodes, 0);
  return { text: out, cursor: cursor < 0 ? out.length : cursor };
};
