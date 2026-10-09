// Vault pickers for adding individual notes/PDFs or folders to the study library.
import { FuzzySuggestModal, TFile, TFolder, type App, type FuzzyMatch } from "obsidian";
import type { Concept } from "../../core/types";
import { isDue, isNew } from "../../core/srs";

export class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private inLibrary: (path: string) => boolean,
    private onPick: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Add a note or PDF to Claude Tutor…");
    this.setInstructions([
      { command: "↵", purpose: "add" },
      { command: "esc", purpose: "close" },
    ]);
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => ["md", "pdf"].includes(f.extension.toLowerCase()) && !f.path.startsWith(this.app.vault.configDir + "/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  renderSuggestion(m: FuzzyMatch<TFile>, el: HTMLElement) {
    super.renderSuggestion(m, el);
    if (m.item.extension.toLowerCase() === "pdf") el.createSpan({ text: " PDF", cls: "ct-suggest-tag" });
    if (this.inLibrary(m.item.path)) el.createSpan({ text: " already in library", cls: "ct-suggest-note" });
  }

  onChooseItem(f: TFile) {
    this.onPick(f);
  }
}

export class FolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private onPick: (folder: TFolder) => void,
  ) {
    super(app);
    this.setPlaceholder("Add a folder to Claude Tutor…");
  }

  getItems(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !f.path.startsWith(this.app.vault.configDir));
  }

  getItemText(f: TFolder): string {
    return f.isRoot() ? "/ (whole vault)" : f.path;
  }

  onChooseItem(f: TFolder) {
    this.onPick(f);
  }
}

export class ImagePicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private exts: string[],
    private onPick: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Attach an image from your vault…");
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => this.exts.includes(f.extension.toLowerCase()))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  onChooseItem(f: TFile) {
    this.onPick(f);
  }
}

/** Search every concept in the library and pick one to explain. */
export class ConceptPicker extends FuzzySuggestModal<Concept> {
  constructor(
    app: App,
    private concepts: Concept[],
    private noteTitle: (key: string) => string,
    private onPick: (c: Concept) => void,
  ) {
    super(app);
    this.setPlaceholder("Explain a concept…");
    this.setInstructions([
      { command: "↵", purpose: "explain it" },
      { command: "esc", purpose: "close" },
    ]);
  }

  getItems(): Concept[] {
    // Due first, then weakest.
    return [...this.concepts].sort((a, b) => Number(isDue(b)) - Number(isDue(a)) || a.mastery - b.mastery);
  }

  getItemText(c: Concept): string {
    return `${c.name} · ${this.noteTitle(c.note_path)}`;
  }

  renderSuggestion(m: FuzzyMatch<Concept>, el: HTMLElement) {
    super.renderSuggestion(m, el);
    if (isNew(m.item)) el.createSpan({ text: " new", cls: "ct-suggest-tag" });
    else if (isDue(m.item)) el.createSpan({ text: " due", cls: "ct-suggest-note" });
  }

  onChooseItem(c: Concept) {
    this.onPick(c);
  }
}
