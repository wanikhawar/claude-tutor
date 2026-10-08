import { vi } from "vitest";

export class TAbstractFile { path = ""; name = ""; }
export class TFile extends TAbstractFile { extension = "md"; basename = ""; stat = { size: 0, mtime: 0, ctime: 0 }; }
export class TFolder extends TAbstractFile { isRoot() { return this.path === "/"; } }
export class App {}
export class FileSystemAdapter {}
export class Component { load() {} unload() {} }
export class ItemView {}
export class Scope { register() {} }
export class Setting {}
export class PluginSettingTab {}
export class FuzzySuggestModal {}
export class Notice { constructor(public message: string) {} }
export class Plugin {
  constructor(public app: unknown, public manifest: unknown) {}
  loadData = vi.fn(async (): Promise<unknown> => null);
  saveData = vi.fn(async (_data: unknown) => {});
  registerEvent() {}
  registerView() {}
  addRibbonIcon() {}
  addSettingTab() {}
  addCommand() {}
}
class MenuItem {
  setTitle() { return this; }
  setIcon() { return this; }
  setIsLabel() { return this; }
  setChecked() { return this; }
  onClick() { return this; }
}
export class Menu {
  addItem(fn: (item: MenuItem) => void) { fn(new MenuItem()); return this; }
  showAtMouseEvent() {}
}
export const MarkdownRenderer = {
  async render(_app: unknown, text: string, target: HTMLElement) {
    const p = document.createElement("p");
    p.textContent = text;
    target.append(p);
  },
};
export const addIcon = () => {};
export const loadMathJax = async () => {};
export const loadPdfJs = async () => {};
export const normalizePath = (path: string) => path.replace(/\/+/g, "/");
export function debounce(fn: () => void, delay: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
    return run;
  };
  run.cancel = () => { clearTimeout(timer); return run; };
  return run;
}
