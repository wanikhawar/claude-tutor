// The study library: the vault's in-scope Markdown notes and PDFs, kept in sync with edits.

import { FileSystemAdapter, TFile, loadPdfJs, normalizePath, type App } from "obsidian";
import { sha256 } from "./core/hash";
import { parseMarkdown } from "./core/notes";
import { checkTextLayer, pdfjsPages, pdftotextPages, split, type PdfJs } from "./core/pdf";
import type { Note, Skipped } from "./core/types";
import type { TutorSettings } from "./settings";

const byPath = new Intl.Collator(undefined, { sensitivity: "base" });
/** How many files a scan reads at once. */
const LOAD_WORKERS = 8;
/** Cached PDF text is named `<pathHash>-<versionHash>.json`, so one file's old versions can be found. */
const pathHash = (path: string) => sha256(path).slice(0, 16);

export class Library {
  /** Notes by key (a Markdown file, or one page-range part of a PDF). */
  notes = new Map<string, Note>();
  skipped = new Map<string, Skipped>();
  private disposed = false;
  private scan = 0;
  private loads = new Map<string, { token: symbol; task: Promise<string[]> }>();
  /** Cache reads, writes and cleanup for one PDF run one at a time, so a cleanup can't delete an entry mid-read. */
  private cacheLocks = new Map<string, Promise<unknown>>();
  /** A PDF was read into these parts, which may not be the page ranges it had before. */
  onPdfParts?: (path: string, parts: Note[]) => void;

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
    // Not cleared: notes still in scope stay usable while the scan reaches them. Only what left scope goes.
    const files = this.candidates();
    const inScope = new Set(files.map((f) => f.path));
    for (const [k, n] of this.notes) if (!inScope.has(n.path)) this.notes.delete(k);
    for (const p of this.skipped.keys()) if (!inScope.has(p)) this.skipped.delete(p);
    // A few files at a time: reading one by one is slow on a big vault. A newer scan or dispose stops the workers.
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        if (this.disposed || this.scan !== scan) return;
        await this.loadFile(files[next++]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOAD_WORKERS, files.length) }, worker));
    if (this.disposed || this.scan !== scan) return;
    await this.pruneCache(
      files.filter((f) => f.path.toLowerCase().endsWith(".pdf")),
      scan,
    );
  }

  /** Drop cached PDF text for files no longer in scope, and old-format entries. Best-effort. */
  private async pruneCache(pdfs: TFile[], scan: number) {
    const stale = () => this.disposed || this.scan !== scan;
    try {
      const adapter = this.app.vault.adapter;
      const keep = new Set(pdfs.map((f) => pathHash(f.path)));
      const entries = (await adapter.list(this.cacheDir)).files;
      for (const entry of entries) {
        // A newer scan may have put more PDFs in scope while we waited; its entries must stay.
        if (stale()) return;
        const name = entry.split("/").pop() ?? "";
        if (keep.has(name.split("-")[0]) && name.includes("-")) continue;
        await adapter.remove(entry).catch(() => {});
      }
    } catch {
      // Pruning is best-effort.
    }
  }

  /** (Re)load one file. Returns the keys it produced. */
  async loadFile(file: TFile): Promise<string[]> {
    if (this.disposed) return [];
    const path = file.path;
    if (this.app.vault.getAbstractFileByPath(path) !== file) return [];
    // Notes already loaded stay until the new read lands (see `readFile`); only a file out of scope goes now.
    if (!this.inScope(path)) {
      this.removeFile(path);
      return [];
    }
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
    const current = () =>
      !this.disposed &&
      this.loads.get(path)?.token === token &&
      file.path === path &&
      this.inScope(path) &&
      this.app.vault.getAbstractFileByPath(path) === file;
    try {
      const notes =
        file.extension.toLowerCase() === "pdf" ? await this.readPdf(file, current) : [await this.readMarkdown(file)];
      if (!current()) return [];
      const kept = notes.filter((n) => n.body.trim());
      this.dropLoaded(path);
      for (const n of kept) this.notes.set(n.key, n);
      if (kept.length && kept[0].kind === "pdf") this.onPdfParts?.(path, kept);
      return kept.map((n) => n.key);
    } catch (e) {
      if (!current()) return [];
      this.dropLoaded(path);
      this.skipped.set(path, { rel: path, reason: e instanceof Error ? e.message : String(e) });
      return [];
    } finally {
      if (this.loads.get(path)?.token === token) this.loads.delete(path);
    }
  }

  /** Forget what an earlier read of one file produced, keeping any read in flight. */
  private dropLoaded(path: string) {
    for (const [k, n] of this.notes) if (n.path === path) this.notes.delete(k);
    this.skipped.delete(path);
  }

  removeFile(path: string) {
    const under = (p: string) => p === path || p.startsWith(`${path}/`);
    for (const key of this.loads.keys()) if (under(key)) this.loads.delete(key);
    for (const [k, n] of this.notes) if (under(n.path)) this.notes.delete(k);
    for (const key of this.skipped.keys()) if (under(key)) this.skipped.delete(key);
  }

  sorted(): Note[] {
    return [...this.notes.values()].sort(
      (a, b) => byPath.compare(a.path, b.path) || (a.pages?.[0] ?? 0) - (b.pages?.[0] ?? 0),
    );
  }

  private async readMarkdown(file: TFile): Promise<Note> {
    const raw = await this.app.vault.cachedRead(file);
    const { title, body, links } = parseMarkdown(raw, file.basename);
    return {
      key: file.path,
      path: file.path,
      title,
      body,
      hash: sha256(raw),
      links,
      kind: "markdown",
      group: null,
      pages: null,
    };
  }

  private async readPdf(file: TFile, current: () => boolean): Promise<Note[]> {
    const pages = await this.pdfPages(file, current);
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

  private withCacheLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.cacheLocks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.cacheLocks.set(key, tail);
    void tail.then(() => {
      if (this.cacheLocks.get(key) === tail) this.cacheLocks.delete(key);
    });
    return run;
  }

  /** Page texts, cached by path + size + modification time. Older versions of the same file are removed. */
  private async pdfPages(file: TFile, current: () => boolean): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    const prefix = pathHash(file.path);
    const version = sha256(`${file.path}|${file.stat.size}|${file.stat.mtime}`).slice(0, 16);
    const cacheFile = normalizePath(`${this.cacheDir}/${prefix}-${version}.json`);
    const cached = await this.withCacheLock(prefix, async () => {
      try {
        if (await adapter.exists(cacheFile)) return JSON.parse(await adapter.read(cacheFile)) as string[];
      } catch {
        // Unreadable cache entry: extract again.
      }
      return null;
    });
    if (cached) return cached;

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

    // A superseded read must not write or clean up: it could delete the entry a newer read just wrote.
    if (!current()) return pages;
    await this.withCacheLock(prefix, async () => {
      // Re-check inside the lock: a newer read may have started while this one waited.
      if (!current()) return;
      try {
        if (!(await adapter.exists(this.cacheDir))) await adapter.mkdir(this.cacheDir);
        await adapter.write(cacheFile, JSON.stringify(pages));
        // An edit or rename leaves the old text behind; keep only the newest entry for this file.
        for (const entry of (await adapter.list(this.cacheDir)).files) {
          const name = entry.split("/").pop() ?? "";
          if (!current()) break;
          if (name.startsWith(`${prefix}-`) && normalizePath(entry) !== cacheFile)
            await adapter.remove(entry).catch(() => {});
        }
      } catch {
        // Caching is best-effort.
      }
    });
    return pages;
  }
}
