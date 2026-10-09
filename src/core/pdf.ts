// PDF text: extraction, re-flowing, and splitting long documents into page-range parts
// that each fit in one Claude request.

import { execFile } from "node:child_process";

/** Target size of one part (the per-request note budget is 30k). */
export const PART_CHARS = 24_000;
/** Below this many characters per page on average, there's no usable text layer. */
const MIN_CHARS_PER_PAGE = 40;

export interface Part {
  first: number;
  last: number;
  /** Page texts, each preceded by a `[Page N]` marker so Claude can cite pages. */
  text: string;
}

/** Text of each page via poppler's `pdftotext` (best reading order and column handling). */
export function pdftotextPages(fullPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "pdftotext",
      ["-enc", "UTF-8", "-q", fullPath, "-"],
      { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PATH: `/usr/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}` } },
      (err, stdout) => {
        if (err) return reject(new Error(`pdftotext failed: ${err.message}`));
        const pages = stdout.split("\f").map(cleanPage);
        if (pages.length && !pages[pages.length - 1]) pages.pop();
        resolve(pages);
      },
    );
  });
}

/** Minimal slice of pdf.js used for the fallback (Obsidian bundles pdf.js). */
export interface PdfJs {
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc> };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }>;
  destroy?(): Promise<void>;
}

export async function pdfjsPages(pdfjs: PdfJs, data: Uint8Array): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    let text = "";
    for (const item of content.items) {
      text += item.str ?? "";
      if (item.hasEOL) text += "\n";
    }
    pages.push(cleanPage(text));
  }
  await doc.destroy?.();
  return pages;
}

export function checkTextLayer(pages: string[]) {
  const chars = pages.reduce((n, p) => n + p.replace(/\s/g, "").length, 0);
  if (!pages.length || chars / pages.length < MIN_CHARS_PER_PAGE) {
    throw new Error("no text layer (it may be a scanned PDF)");
  }
}

const LIGATURES: Record<string, string> = { "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl" };

function loneBullet(line: string): string | null {
  if (line === "•" || line === "◦" || line === "▪") return "•";
  if (line === "–" || line === "-" || line === "*") return "-";
  return null;
}

function startsListItem(line: string): boolean {
  const l = line.trimStart();
  return /^[•◦▪–*]/.test(l) || l.startsWith("- ") || /^\d{1,3}[.)]/.test(l);
}

/**
 * Re-flow hard-wrapped lines into paragraphs and undo end-of-line hyphenation,
 * keeping headings, list items and other short lines on their own lines.
 */
export function cleanPage(raw: string): string {
  raw = raw.replace(/[ﬀ-ﬄ]/g, (c) => LIGATURES[c] ?? c);
  const paras: string[] = [];
  let bullet: string | null = null;
  for (const block of raw.split("\n\n").map((b) => b.trim()).filter(Boolean)) {
    const lines = block
      .split("\n")
      .map((l) => l.split(/\s+/).filter(Boolean).join(" "))
      .filter(Boolean);
    let out = bullet ? `${bullet} ` : "";
    bullet = null;
    // pdf text often puts a list bullet alone on a line, apart from its text.
    const next = lines.length ? loneBullet(lines[lines.length - 1]) : null;
    if (next) lines.pop();
    // Typical line width; a line much shorter than this ended a heading or paragraph.
    const widths = lines.map((l) => [...l].length).sort((a, b) => a - b);
    const typical = widths[Math.floor(widths.length / 2)] ?? 0;
    let prev: string | null = null;
    for (const line of lines) {
      if (prev === null) out += line;
      else {
        const short = [...prev].length * 10 < typical * 6 && !/[,-]$/.test(prev);
        if (short || startsListItem(line)) out += `\n${line}`;
        else if (prev.endsWith("-") && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line;
        else out += ` ${line}`;
      }
      prev = line;
    }
    bullet = next;
    if (lines.length) paras.push(out);
  }
  return paras.join("\n\n");
}

/** Group pages into parts of roughly `PART_CHARS` characters, never splitting a page. */
export function split(pages: string[], partChars = PART_CHARS): Part[] {
  const parts: Part[] = [];
  let cur = "";
  let first = 1;
  pages.forEach((page, i) => {
    const n = i + 1;
    if (!page.trim()) return;
    if (cur && cur.length + page.length > partChars) {
      parts.push({ first, last: n - 1, text: cur });
      cur = "";
    }
    if (!cur) first = n;
    else cur += "\n\n";
    cur += `[Page ${n}]\n\n${page}`;
  });
  if (cur) parts.push({ first, last: pages.length, text: cur });
  return parts;
}
