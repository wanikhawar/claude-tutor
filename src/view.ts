import { ItemView, Scope, type WorkspaceLeaf } from "obsidian";
import { mount, unmount } from "svelte";
import App from "./ui/App.svelte";
import { store } from "./ui/lib/store.svelte";

export const VIEW_TYPE = "claude-tutor";

type Box = Pick<DOMRect, "top" | "bottom" | "left" | "right" | "height">;

/** How much of the view's bottom the status bar covers, in pixels (0 if it doesn't overlap). */
export function statusGap(view: Box, bar?: Box): number {
  if (!bar || bar.height <= 0) return 0;
  const overlaps = bar.left < view.right && bar.right > view.left && bar.top < view.bottom && bar.bottom > view.top;
  return overlaps ? Math.ceil(view.bottom - bar.top) : 0;
}

export class TutorView extends ItemView {
  private app_: ReturnType<typeof mount> | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    // Obsidian handles hotkeys before page elements see the key, and its own Mod+Enter
    // binding would swallow it. A view scope is checked first while this view is focused.
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "Enter", () => (store.primary() ? false : undefined));
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Claude Tutor";
  }

  getIcon() {
    return "clawd";
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("ct-view");
    this.app_ = mount(App, { target: this.contentEl, props: { component: this } });
    this.clearStatusBar();
  }

  /**
   * Obsidian's status bar floats over the bottom-right corner of the window, which is
   * where the tutor's entry box and model picker sit in the right sidebar. Measure how
   * much of the view it covers and keep that strip free (`--ct-status-gap`).
   */
  private clearStatusBar() {
    const el = this.contentEl;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bar = el.doc.querySelector(".status-bar")?.getBoundingClientRect();
      el.setCssProps({ "--ct-status-gap": `${statusGap(el.getBoundingClientRect(), bar)}px` });
    };
    const later = () => {
      if (!frame) frame = el.win.requestAnimationFrame(measure);
    };
    // The bar changes size with its contents (word counts and the like); the view, as panes move.
    const observer = new ResizeObserver(later);
    observer.observe(el);
    const bar = el.doc.querySelector(".status-bar");
    if (bar) observer.observe(bar);
    this.registerEvent(this.app.workspace.on("layout-change", later));
    this.registerEvent(this.app.workspace.on("css-change", later));
    this.register(() => {
      observer.disconnect();
      if (frame) el.win.cancelAnimationFrame(frame);
    });
    later();
  }

  async onClose() {
    if (this.app_) await unmount(this.app_);
    this.app_ = null;
  }
}
