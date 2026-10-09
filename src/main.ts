import { FileSystemAdapter, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, addIcon, debounce, loadMathJax, normalizePath, type Debouncer, type WorkspaceLeaf } from "obsidian";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Backend } from "./backend";
import { Library } from "./library";
import { Progress, emptyProgress, type ProgressData } from "./core/progress";
import { remapPath } from "./core/paths";
import { DEFAULT_SETTINGS, TutorSettingTab, type TutorSettings } from "./settings";
import { TutorView, VIEW_TYPE } from "./view";
import { store } from "./ui/lib/store.svelte";

// Obsidian doesn't await onunload(), so on a plugin reload the new instance could read
// progress.json before the old one's final save lands. The pending save is parked on
// globalThis (module state doesn't survive a reload) and awaited before loading.
const PENDING_SAVES = Symbol.for("claude-tutor.pending-progress-saves");
type PendingSaves = Map<string, Promise<void>>;
function pendingSaves(): PendingSaves {
  const g = window as unknown as Record<symbol, PendingSaves | undefined>;
  let saves = g[PENDING_SAVES];
  if (!saves) g[PENDING_SAVES] = saves = new Map();
  return saves;
}

// Clawd silhouette for the ribbon: body with glasses knocked out (monochrome, follows the theme).
const CLAWD_ICON = `<mask id="ct-lenses"><rect width="100" height="100" fill="white"/><rect x="24" y="44" width="20" height="18" rx="3" fill="black"/><rect x="56" y="44" width="20" height="18" rx="3" fill="black"/></mask>
<g fill="currentColor"><g mask="url(#ct-lenses)"><rect x="19" y="31" width="62" height="44"/><rect x="6" y="50" width="13" height="13"/><rect x="81" y="50" width="13" height="13"/></g>
<rect x="31" y="47" width="6" height="11"/><rect x="63" y="47" width="6" height="11"/><rect x="44" y="51" width="12" height="2.5"/>
<rect x="25" y="75" width="6" height="12"/><rect x="37" y="75" width="6" height="12"/><rect x="57" y="75" width="6" height="12"/><rect x="69" y="75" width="6" height="12"/></g>`;

export default class ClaudeTutorPlugin extends Plugin {
  settings: TutorSettings = { ...DEFAULT_SETTINGS };
  backend!: Backend;
  private progressFile = "";
  private pendingReloads = new Map<string, number>();
  private saveQueue: Promise<void> = Promise.resolve();
  private scheduleSave?: Debouncer<[], void>;
  private unloaded = false;

  async onload() {
    await this.loadSettings();
    if (this.unloaded) return;
    const dir = this.manifest.dir ?? normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    this.progressFile = normalizePath(`${dir}/progress.json`);
    this.scheduleSave = debounce(() => {
      void this.saveProgress().catch((e) => new Notice(`Claude Tutor: couldn't save progress (${e}).`));
    }, 1500, true);
    await pendingSaves().get(this.progressFile);
    // Disabled while waiting for the previous instance's save: start nothing.
    if (this.unloaded) return;
    const data = await this.loadProgress();
    if (this.unloaded) return;
    const progress = new Progress(data, () => {
      if (!this.unloaded) this.scheduleSave?.();
    });
    const library = new Library(this.app, () => this.settings, normalizePath(`${dir}/pdf-cache`));
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const cwd = adapter.getBasePath ? `${adapter.getBasePath()}/${dir}` : tmpdir();
    this.backend = new Backend(
      this.app,
      library,
      progress,
      () => this.settings,
      cwd,
      () => this.openSettings(),
      () => this.saveSettings(),
    );
    store.init(this.backend, () => this.settings, () => this.saveSettings());

    addIcon("clawd", CLAWD_ICON);
    // Formulae in Claude's answers are rendered by Obsidian's MathJax.
    void loadMathJax();
    this.registerView(VIEW_TYPE, (leaf) => new TutorView(leaf));
    this.addRibbonIcon("clawd", "Open Claude Tutor", () => void this.activate());
    this.addSettingTab(new TutorSettingTab(this.app, this));
    this.registerCommands();
    this.registerFileMenu();

    this.app.workspace.onLayoutReady(async () => {
      if (this.unloaded) return;
      // A tutor tab restored from an older layout moves to the sidebar (or back) to match the setting.
      await this.placeView();
      if (this.unloaded) return;
      // Listen before scanning so notes created or edited during a slow scan aren't missed.
      this.registerVaultEvents();
      await library.loadAll();
      if (this.unloaded) return;
      this.backend.emit();
    });
  }

  /** Settles once the final progress save has landed (onunload itself must return void). */
  unloading: Promise<void> = Promise.resolve();

  onunload() {
    this.unloading = this.finishUnload();
  }

  private async finishUnload() {
    this.unloaded = true;
    this.scheduleSave?.cancel();
    for (const timer of this.pendingReloads.values()) window.clearTimeout(timer);
    this.pendingReloads.clear();
    store.dispose();
    this.backend?.dispose();
    if (!this.progressFile) return;
    const saves = pendingSaves();
    // Chain onto any earlier instance's save, so an instance unloaded before it finished
    // loading doesn't replace that save with its own empty one.
    const prior = saves.get(this.progressFile) ?? Promise.resolve();
    const save = prior.then(() => this.saveProgress()).catch(() => {});
    saves.set(this.progressFile, save);
    void save.then(() => {
      if (saves.get(this.progressFile) === save) saves.delete(this.progressFile);
    });
    await save;
  }

  // -------------------------------------------------------------------------
  // Persistence

  async loadSettings() {
    const saved = ((await this.loadData()) ?? {}) as Partial<TutorSettings>;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      resolvedModels: { ...DEFAULT_SETTINGS.resolvedModels, ...(saved.resolvedModels ?? {}) },
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.backend?.emit();
  }

  private async loadProgress(): Promise<ProgressData> {
    try {
      if (await this.app.vault.adapter.exists(this.progressFile)) {
        return { ...emptyProgress(), ...(JSON.parse(await this.app.vault.adapter.read(this.progressFile)) as Partial<ProgressData>) };
      }
    } catch (e) {
      new Notice(`Claude Tutor: couldn't read progress.json (${e instanceof Error ? e.message : String(e)}). Starting fresh; the old file was kept.`);
      await this.app.vault.adapter.copy(this.progressFile, `${this.progressFile}.bak`).catch(() => {});
    }
    return emptyProgress();
  }

  private saveProgress(): Promise<void> {
    if (!this.backend) return Promise.resolve();
    const data = JSON.stringify(this.backend.progress.data);
    const save = this.saveQueue.then(async () => {
      const tmp = `${this.progressFile}.tmp`;
      const adapter = this.app.vault.adapter;
      await adapter.write(tmp, data);
      // Obsidian's adapter rejects existing destinations. Desktop filesystem rename
      // replaces the file atomically without deleting the last good save first.
      if (adapter instanceof FileSystemAdapter) {
        await rename(adapter.getFullPath(tmp), adapter.getFullPath(this.progressFile));
      } else {
        await adapter.rename(tmp, this.progressFile);
      }
    });
    // A failed write must not prevent later saves (including the unload save).
    this.saveQueue = save.catch(() => {});
    return save;
  }

  // -------------------------------------------------------------------------
  // UI entry points

  async activate() {
    const leaf = (await this.placeView()) ?? (await this.openView(true));
    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * The open tutor view, moved to the right sidebar (or a main tab) if it isn't where the
   * "Open in right sidebar" setting says. Undefined when it isn't open.
   */
  async placeView(): Promise<WorkspaceLeaf | undefined> {
    const { workspace } = this.app;
    const leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf || (leaf.getRoot() === workspace.rightSplit) === this.settings.openInSidebar) return leaf;
    leaf.detach();
    return this.openView(false);
  }

  private async openView(active: boolean): Promise<WorkspaceLeaf> {
    const { workspace } = this.app;
    const leaf = (this.settings.openInSidebar ? workspace.getRightLeaf(false) : workspace.getLeaf("tab"))!;
    await leaf.setViewState({ type: VIEW_TYPE, active });
    return leaf;
  }

  openSettings() {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /** Make sure a note is part of the library (adding it individually if needed), then run `then`. */
  private async withNote(file: TFile, then: (keys: string[], request: number) => void) {
    if (!["md", "pdf"].includes(file.extension.toLowerCase())) {
      new Notice("Claude Tutor works with Markdown notes and PDFs.");
      return;
    }
    const request = store.beginStudyRequest();
    if (!this.backend.library.inScope(file.path)) {
      this.settings.studyFiles.push(file.path);
      await this.saveSettings();
    }
    if (!store.isCurrentStudyRequest(request)) return;
    const keys = await this.backend.library.loadFile(file);
    this.backend.emit();
    if (!store.isCurrentStudyRequest(request)) return;
    if (!keys.length) {
      const why = this.backend.library.skipped.get(file.path)?.reason;
      new Notice(`Claude Tutor couldn't read this file${why ? `: ${why}` : "."}`);
      return;
    }
    await this.activate();
    if (store.isCurrentStudyRequest(request)) then(keys, request);
  }

  private registerCommands() {
    this.addCommand({ id: "open", name: "Open", callback: () => void this.activate() });
    this.addCommand({
      id: "start-session",
      name: "Start study session",
      callback: async () => {
        await this.activate();
        store.startStudy();
      },
    });
    this.addCommand({
      id: "quiz-current-note",
      name: "Quiz me on the current note",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return false;
        if (!checking) void this.withNote(f, (keys, request) => void store.studyNote(keys, "quiz", request));
        return true;
      },
    });
    this.addCommand({
      id: "explain-current-note",
      name: "Explain a concept from the current note",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return false;
        if (!checking) void this.withNote(f, (keys, request) => void store.studyNote(keys, "explain", request));
        return true;
      },
    });
    this.addCommand({
      id: "rescan",
      name: "Re-scan study folders",
      callback: async () => {
        await this.backend.rescan();
        new Notice("Claude Tutor: library re-scanned.");
      },
    });
  }

  private registerFileMenu() {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || !["md", "pdf"].includes(file.extension.toLowerCase())) return;
        menu.addItem((i) =>
          i
            .setTitle("Quiz me on this (Claude Tutor)")
            .setIcon("zap")
            .onClick(() => void this.withNote(file, (keys, request) => void store.studyNote(keys, "quiz", request))),
        );
        menu.addItem((i) =>
          i
            .setTitle("Explain it to Clawd (Claude Tutor)")
            .setIcon("clawd")
            .onClick(() => void this.withNote(file, (keys, request) => void store.studyNote(keys, "explain", request))),
        );
      }),
    );
  }

  /** Keep the library in sync with the vault. Edits are reloaded after a short pause in typing. */
  private registerVaultEvents() {
    const lib = this.backend.library;
    const reload = (file: TFile) => {
      if (this.unloaded) return;
      const path = file.path;
      window.clearTimeout(this.pendingReloads.get(path));
      this.pendingReloads.set(
        path,
        window.setTimeout(() => void (async () => {
          this.pendingReloads.delete(path);
          if (this.unloaded) return;
          await lib.loadFile(file);
          if (this.unloaded) return;
          this.backend.emit();
        })(), 2000),
      );
    };
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile && lib.inScope(f.path)) reload(f);
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (f) => {
        if (f instanceof TFile && lib.inScope(f.path)) reload(f);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        lib.removeFile(f.path);
        this.backend.emit();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", async (f, oldPath) => {
        if (this.unloaded) return;
        // Update all sources before any asynchronous reload or descendant rename event.
        let changed = false;
        for (const field of ["studyFiles", "studyFolders", "excludedFolders"] as const) {
          this.settings[field] = this.settings[field].map((path) => {
            const moved = remapPath(path, oldPath, f.path);
            changed ||= moved !== path;
            return moved;
          });
        }
        for (const [path, timer] of this.pendingReloads) {
          if (remapPath(path, oldPath, f.path) !== path) {
            window.clearTimeout(timer);
            this.pendingReloads.delete(path);
          }
        }
        this.backend.progress.rename(oldPath, f.path);
        lib.removeFile(oldPath);
        if (changed) await this.saveData(this.settings);
        if (this.unloaded) return;
        if (f instanceof TFile) await lib.loadFile(f);
        else if (f instanceof TFolder) {
          for (const file of this.app.vault.getFiles()) {
            if (this.unloaded) return;
            if (file.path.startsWith(`${f.path}/`)) await lib.loadFile(file);
          }
        }
        if (this.unloaded) return;
        this.backend.emit();
      }),
    );
  }
}
