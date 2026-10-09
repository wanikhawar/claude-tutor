// The study library: the vault's in-scope Markdown notes and PDFs, kept in sync with edits.

import { FileSystemAdapter, TFile, loadPdfJs, normalizePath, type App } from "obsidian";
import { sha256 } from "./core/hash";
import { parseMarkdown } from "./core/notes";
import { checkTextLayer, pdfjsPages, pdftotextPages, split, type PdfJs } from "./core/pdf";
import type { Note, Skipped } from "./core/types";
import type { TutorSettings } from "./settings";

export class Library {
  /** Notes by key (a Markdown file, or one page-range part of a PDF). */
  notes = new Map<string, Note>();
  skipped = new Map<string, Skipped>();
  private disposed = false;
  private scan = 0;
  private loads = new Map<string, { token: symbol; task: Promise<string[]> }>();

  constructor(
    private app: App,
    private settings: () => TutorSettings,
    /** Vault-relative folder for cached PDF text. */
    private cacheDir: string,
  ) {}

  dispose() {
    this.disposed = true;
    this.scan++;
    this.loads.clear();
  }

  inScope(path: string): boolean {
    if (this.disposed) return false;
    const s = this.settings();
    const lower = path.toLowerCase();
    const isMd = lower.endsWith(".md");
    const isPdf = lower.endsWith(".pdf");
    if (!isMd && !(isPdf && s.includePdfs)) return false;
    if (path.startsWith(this.app.vault.configDir + "/")) return false;
    const under = (folder: string) => folder === "/" || path === folder || path.startsWith(folder + "/");
    // A file added on its own stays in scope even inside an excluded folder.
    if (s.studyFiles.includes(path)) return true;
    if (s.excludedFolders.some(under)) return false;
    return s.studyFolders.some(under);
  }

  /** Every file in scope, without reading it (used to size up a folder). */
  candidates(): TFile[] {
    return this.app.vault.getFiles().filter((f) => this.inScope(f.path));
  }

  async loadAll() {
    const scan = ++this.scan;
    this.loads.clear();
    this.notes.clear();
    this.skipped.clear();
    for (const f of this.candidates()) {
      if (this.disposed || this.scan !== scan) return;
      await this.loadFile(f);
    }
  }

  /** (Re)load one file. Returns the keys it produced. */
  async loadFile(file: TFile): Promise<string[]> {
    if (this.disposed) return [];
    const path = file.path;
    if (this.app.vault.getAbstractFileByPath(path) !== file) return [];
    this.removeFile(path);
    if (!this.inScope(path)) return [];
    const token = Symbol(path);
    const task = this.readFile(file, path, token);
    this.loads.set(path, { token, task });
    return task;
  }

  /** Wait for the latest vault read, including one that replaced an earlier read. */
  async waitForFile(key: string) {
    while (!this.disposed) {
      const load = [...this.loads].find(([path]) => key === path || key.startsWith(`${path}#p`))?.[1];
      if (!load) return;
      await load.task;
    }
  }

  private async readFile(file: TFile, path: string, token: symbol): Promise<string[]> {
    const current = () => !this.disposed && this.loads.get(path)?.token === token && file.path === path &&
      this.inScope(path) && this.app.vault.getAbstractFileByPath(path) === file;
    try {
      const notes = file.extension.toLowerCase() === "pdf" ? await this.readPdf(file) : [await this.readMarkdown(file)];
      if (!current()) return [];
      const kept = notes.filter((n) => n.body.trim());
      for (const n of kept) this.notes.set(n.key, n);
      return kept.map((n) => n.key);
    } catch (e) {
      if (!current()) return [];
      this.skipped.set(path, { rel: path, reason: e instanceof Error ? e.message : String(e) });
      return [];
    } finally {
      if (this.loads.get(path)?.token === token) this.loads.delete(path);
    }
  }

  removeFile(path: string) {
    const under = (p: string) => p === path || p.startsWith(`${path}/`);
    for (const key of this.loads.keys()) if (under(key)) this.loads.delete(key);
    for (const [k, n] of this.notes) if (under(n.path)) this.notes.delete(k);
    for (const key of this.skipped.keys()) if (under(key)) this.skipped.delete(key);
  }

  sorted(): Note[] {
    return [...this.notes.values()].sort(
      (a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }) || (a.pages?.[0] ?? 0) - (b.pages?.[0] ?? 0),
    );
  }

  private async readMarkdown(file: TFile): Promise<Note> {
    const raw = await this.app.vault.cachedRead(file);
    const { title, body, links } = parseMarkdown(raw, file.basename);
    return { key: file.path, path: file.path, title, body, hash: sha256(raw), links, kind: "markdown", group: null, pages: null };
  }

  private async readPdf(file: TFile): Promise<Note[]> {
    const pages = await this.pdfPages(file);
    const parts = split(pages);
    const multi = parts.length > 1;
    return parts.map((p) => {
      const range = p.first === p.last ? `p. ${p.first}` : `pp. ${p.first}–${p.last}`;
      return {
        key: multi ? `${file.path}#p${p.first}-${p.last}` : file.path,
        path: file.path,
        title: multi ? `${file.basename} · ${range}` : file.basename,
        body: p.text,
        hash: sha256(p.text),
        links: [],
        kind: "pdf",
        group: multi ? file.path : null,
        pages: [p.first, p.last],
      };
    });
  }

  /** Page texts, cached by path + size + modification time. */
  private async pdfPages(file: TFile): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    const id = sha256(`${file.path}|${file.stat.size}|${file.stat.mtime}`).slice(0, 32);
    const cacheFile = normalizePath(`${this.cacheDir}/${id}.json`);
    try {
      if (await adapter.exists(cacheFile)) return JSON.parse(await adapter.read(cacheFile)) as string[];
    } catch {
      // Unreadable cache entry: extract again.
    }

    let pages: string[] | null = null;
    if (adapter instanceof FileSystemAdapter) {
      try {
        pages = await pdftotextPages(adapter.getFullPath(file.path));
      } catch {
        // pdftotext missing or failed: fall back to pdf.js below.
      }
    }
    if (!pages) {
      const pdfjs = (await loadPdfJs()) as PdfJs;
      pages = await pdfjsPages(pdfjs, new Uint8Array(await this.app.vault.readBinary(file)));
    }
    checkTextLayer(pages);

    try {
      if (!(await adapter.exists(this.cacheDir))) await adapter.mkdir(this.cacheDir);
      await adapter.write(cacheFile, JSON.stringify(pages));
    } catch {
      // Caching is best-effort.
    }
    return pages;
  }
}
