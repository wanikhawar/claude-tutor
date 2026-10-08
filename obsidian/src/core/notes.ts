// Turning Markdown files into teachable notes.

/** Split `---\n...\n---` YAML frontmatter from the content. */
export function splitFrontmatter(raw: string): [string, string] {
  const s = raw.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[^\n]*(?:\r?\n|$)/.exec(s);
  return m ? [m[1], s.slice(m[0].length)] : ["", s];
}

/** Replace `[[target|alias]]`, `[[target]]` and `![[embed]]` with display text. */
export function resolveWikilinks(s: string): [string, string[]] {
  const links: string[] = [];
  const out = s.replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const bar = inner.indexOf("|");
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).split("#")[0].trim();
    const alias = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
    if (target && !links.includes(target)) links.push(target);
    return alias;
  });
  return [out, links];
}

/** Obsidian `%%comments%%` aren't part of the note's content. */
export function stripComments(s: string): string {
  return s.replace(/%%[\s\S]*?%%/g, "");
}

export function noteTitle(front: string, body: string, basename: string): string {
  const t = /^title:\s*(.+)$/m.exec(front)?.[1].trim().replace(/^["']|["']$/g, "");
  if (t) return t;
  const h1 = /^# (.+)$/m.exec(body)?.[1].trim();
  return h1 || basename;
}

export function parseMarkdown(raw: string, basename: string) {
  const [front, content] = splitFrontmatter(raw);
  const [body, links] = resolveWikilinks(stripComments(content));
  return { title: noteTitle(front, body, basename), body, links };
}

/** Truncate to at most `max` characters, marking the cut. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated]`;
}
