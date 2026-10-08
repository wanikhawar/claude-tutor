import { ItemView, Scope, type WorkspaceLeaf } from "obsidian";
import { mount, unmount } from "svelte";
import App from "./ui/App.svelte";
import { store } from "./ui/lib/store.svelte";

export const VIEW_TYPE = "claude-tutor";

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
  }

  async onClose() {
    if (this.app_) await unmount(this.app_);
    this.app_ = null;
  }
}
