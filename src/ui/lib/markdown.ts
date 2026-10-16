// Showing a reply without letting it reach the network. A reply can quote your notes, and a
// note can carry instructions for the model (prompt injection): an image whose URL holds that
// text would send it to someone else's server the moment the reply is shown. So replies are
// rendered by Obsidian into an inert document, where nothing loads, and the view shows checked
// copies: remote images become links, and frames, media and styles are dropped.

import { MarkdownRenderer, type App, type Component } from "obsidian";
import { CSS_FETCH, FETCHING_ATTRIBUTES, FETCHING_ELEMENTS } from "../../core/inert";

const LOCAL = /^(app|data|blob):/i;

/** A copy of a rendered node that's safe to show. The copy is made and checked in the inert document. */
function safeCopy(node: Node): Node {
  const copy = node.cloneNode(true);
  if (copy.nodeType !== Node.ELEMENT_NODE) return copy;
  const top = copy as Element;
  // The top element has no parent to be replaced in, so its replacement is returned instead.
  const swap = safeElement(top);
  if (swap) return swap;
  for (const e of Array.from(top.querySelectorAll("*"))) {
    const replacement = safeElement(e);
    if (replacement) e.replaceWith(replacement);
  }
  return top;
}

/** Strips what `e` would fetch, or returns what should take its place. */
function safeElement(e: Element): Node | null {
  const name = e.localName.toLowerCase();
  // Replaced one for one, never removed: clicks find their original by position.
  if (FETCHING_ELEMENTS.has(name)) return e.ownerDocument.createComment("");
  if (name === "img") {
    const src = e.getAttribute("src") ?? "";
    if (!LOCAL.test(src.trim())) return imageLink(e, src);
  }
  for (const a of Array.from(e.attributes)) {
    const n = a.name.toLowerCase();
    const keepSrc = n === "src" && name === "img";
    // CSS loads images with url() and image-set(), in styles and SVG attributes like fill;
    // a backslash in a style could be an escape spelling either.
    const css = CSS_FETCH.test(a.value) || (n === "style" && a.value.includes("\\"));
    if ((FETCHING_ATTRIBUTES.has(n) && !keepSrc) || css) e.removeAttribute(a.name);
  }
  return null;
}

/** A remote image as a link you can choose to open. */
function imageLink(img: Element, src: string): Node {
  const alt = img.getAttribute("alt")?.trim() || "image";
  if (!/^https?:/i.test(src.trim())) return img.ownerDocument.createTextNode(alt);
  // A link fetches nothing until it's clicked, so it can be made outside the inert document.
  return createEl("a", {
    cls: "external-link",
    href: src.trim(),
    title: src.trim(),
    text: alt,
    attr: { target: "_blank", rel: "noopener nofollow noreferrer" },
  });
}

/**
 * Render `md` into `target` with Obsidian's renderer (math, code highlighting, theme), never
 * letting what it produces load anything. `inline` drops the wrapping paragraph of a one-line
 * reply. Returns a function that stops following the rendered original.
 *
 * Obsidian keeps working on what it rendered after the first pass (math, copy buttons,
 * callouts, embedded notes), so the rendered nodes themselves never enter the view: it shows
 * checked copies, made again whenever the original changes. Clicks on a copy are passed to
 * the original, so Obsidian's own buttons (copy code, fold a callout) still work.
 */
export function renderMarkdown(
  app: App,
  md: string,
  target: HTMLElement,
  owner: Component,
  inline = false,
): () => void {
  const inert = document.implementation.createHTMLDocument("").body;
  const source = (): Node => {
    const only = inert.firstElementChild;
    return inline && inert.childNodes.length === 1 && only?.tagName === "P" ? only : inert;
  };
  const show = () => target.replaceChildren(...Array.from(source().childNodes, safeCopy));
  const changes = new MutationObserver(show);
  changes.observe(inert, { subtree: true, childList: true, attributes: true, characterData: true });

  const forward = (e: MouseEvent) => {
    let n = e.target as Node | null;
    // Links open from the copy itself.
    if (!n || (n as Element).closest?.("a")) return;
    const path: number[] = [];
    for (; n && n !== target; n = n.parentNode)
      path.unshift(Array.prototype.indexOf.call(n.parentNode?.childNodes ?? [], n));
    if (n !== target) return;
    let original: Node | undefined = source();
    for (const i of path) original = original?.childNodes[i];
    if (original && !original.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))
      e.preventDefault();
  };
  target.addEventListener("click", forward);

  // Obsidian builds the HTML synchronously, so it's in the view straight away. Its promise
  // isn't awaited: it waits for images to load, and in an inert document none ever do.
  void MarkdownRenderer.render(app, md, inert, "", owner);
  show();
  changes.takeRecords();
  return () => {
    changes.disconnect();
    target.removeEventListener("click", forward);
  };
}
