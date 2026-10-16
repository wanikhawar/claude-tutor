// What would load from the web when Obsidian shows some Markdown, and Markdown with it taken
// out. A reply can quote your notes, and a note can carry instructions for the model (prompt
// injection): an image whose URL holds that text would send it to someone else's server the
// moment it's shown. Replies in the tutor are checked after rendering (src/ui/lib/markdown.ts).
// A saved lesson is shown by Obsidian itself, so its text is made safe before it's written.

/** Elements that fetch something (or restyle the app) as soon as they're shown. */
export const FETCHING_ELEMENTS = new Set([
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "video",
  "audio",
  "source",
  "track",
  "picture",
  "link",
  "style",
  "meta",
  "base",
  "script",
  // SVG
  "image",
  "use",
  "feimage",
]);

/** Attributes that fetch something (`src` is fine only on an image that's already local). */
export const FETCHING_ATTRIBUTES = new Set([
  "src",
  "srcset",
  "poster",
  "background",
  "lowsrc",
  "dynsrc",
  "data",
  "ping",
  "formaction",
  "action",
  "xlink:href",
]);

/** CSS that loads an image: url() and image-set(), in styles and SVG attributes like fill. */
export const CSS_FETCH = /url\s*\(|image-set\s*\(/i;

const SPACE = /[\t\n\f\r ]/;
const TAG_NAME = /[^\t\n\f\r />]*/y;

/**
 * The attributes of a tag, read from `from` (just after its name) the way a browser's HTML
 * tokenizer reads them, so a ">" or quote inside a value doesn't end the tag early. An unclosed
 * tag runs to the end of `s`. Names are lowercased; values are left undecoded.
 */
function attributes(s: string, from: number): [string, string][] {
  const found: [string, string][] = [];
  let state: "before" | "name" | "after" | "slash" | "value" | "quoted" | "unquoted" | "closed" = "before";
  let quote = "";
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    const space = SPACE.test(c);
    // Where the spec says to reconsume a character, the loop steps back to read it again.
    if (state === "before") {
      if (c === "/" || c === ">") {
        state = "after";
        i--;
      } else if (!space) {
        found.push([c.toLowerCase(), ""]);
        state = "name";
      }
    } else if (state === "name") {
      if (space || c === "/" || c === ">") {
        state = "after";
        i--;
      } else if (c === "=") state = "value";
      else found[found.length - 1][0] += c.toLowerCase();
    } else if (state === "after") {
      if (c === ">") return found;
      if (c === "/") state = "slash";
      else if (c === "=") state = "value";
      else if (!space) {
        found.push([c.toLowerCase(), ""]);
        state = "name";
      }
    } else if (state === "slash") {
      if (c === ">") return found;
      state = "before";
      i--;
    } else if (state === "value") {
      if (c === ">") return found;
      if (c === '"' || c === "'") {
        quote = c;
        state = "quoted";
      } else if (!space) {
        state = "unquoted";
        i--;
      }
    } else if (state === "quoted") {
      if (c === quote) state = "closed";
      else found[found.length - 1][1] += c;
    } else if (state === "unquoted") {
      if (c === ">") return found;
      if (space) state = "before";
      else found[found.length - 1][1] += c;
    } else {
      // Just after a quoted value.
      if (c === ">") return found;
      if (c === "/") state = "slash";
      else {
        state = "before";
        if (!space) i--;
      }
    }
  }
  return found;
}

/** Whether the tag named `name` with these attributes would fetch something. */
function fetches(name: string, attrs: [string, string][]): boolean {
  if (name === "img" || FETCHING_ELEMENTS.has(name) || FETCHING_ELEMENTS.has(name.split(":").pop()!)) return true;
  return attrs.some(
    ([n, value]) =>
      FETCHING_ATTRIBUTES.has(n) ||
      (n === "href" && name !== "a") ||
      CSS_FETCH.test(value) ||
      // Escapes could spell any of the above: \ in CSS, &…; in any attribute value.
      /[\\&]/.test(value),
  );
}

/**
 * `md` with nothing in it that loads from the web when Obsidian shows it. Images become links
 * (`![[embeds]]` of vault files stay), and HTML that would fetch gets a space after its "<", so
 * it shows as text (and math like `a<b` reads the same if it's caught).
 *
 * This works on the text, not a parse: Obsidian's parser could disagree with one about where
 * code or HTML starts, and hide a fetch in the gap. So code is changed too, and every "<" that
 * could start a tag is checked on its own, even inside another tag's attribute: a parser that
 * finds the outer tag invalid reads the inner one as HTML.
 */
export function inertMarkdown(md: string): string {
  return md
    .replace(/!\[(\[[^[\]\n]*\]\](?![([]))?/g, (all, embed?: string) =>
      // A vault file's name can't contain ":", so a target with one isn't a file in the vault.
      embed && !/^\[[^|#^]*:/.test(embed) ? all : `[${embed ?? ""}`,
    )
    .replace(/<\/?[a-z]/gi, (open: string, at: number, text: string) => {
      // A browser's tag name runs to whitespace, "/" or ">".
      TAG_NAME.lastIndex = at + open.length - 1;
      const name = TAG_NAME.exec(text)![0];
      const attrs = attributes(text, TAG_NAME.lastIndex);
      return fetches(name.toLowerCase(), attrs) ? `< ${open.slice(1)}` : open;
    });
}
