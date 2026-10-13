// Turning Markdown files into teachable notes.

/** Split `---\n...\n---` YAML frontmatter from the content. */
export function splitFrontmatter(raw: string): [string, string] {
  const s = raw.replace(/^\uFEFF/, "");
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
  const t = /^title:\s*(.+)$/m
    .exec(front)?.[1]
    .trim()
    .replace(/^["']|["']$/g, "");
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

/**
 * Split a note into pieces of at most `max` characters, to be read one at a time. Cuts fall
 * between sections where possible, else between paragraphs, then lines, so each piece reads
 * on its own. A note that fits stays whole.
 */
export function chunks(body: string, max: number): string[] {
  if (body.length <= max) return [body];
  return pack(
    sections(body).flatMap((s) => pieces(s, max, [/(?<=\n[ \t]*\n)/, /(?<=\n)/])),
    max,
  ).filter((c) => c.trim());
}

/** The note's heading lines, in order. */
export function headings(body: string): string[] {
  return sections(body)
    .map((s) => s.split("\n", 1)[0].trimEnd())
    .filter((line) => /^#{1,6} /.test(line));
}

/** From each heading to the next. Lines starting with `#` inside code fences aren't headings. */
function sections(body: string): string[] {
  const out: string[] = [];
  let current = "";
  let fenced = false;
  for (const line of body.split(/(?<=\n)/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,6} /.test(line) && current) {
      out.push(current);
      current = "";
    }
    current += line;
  }
  if (current) out.push(current);
  return out;
}

/** Split `s` at the first separator that brings it under `max`, falling back to the next one. */
function pieces(s: string, max: number, separators: RegExp[]): string[] {
  if (s.length <= max) return [s];
  const [separator, ...rest] = separators;
  if (!separator) return Array.from({ length: Math.ceil(s.length / max) }, (_, i) => s.slice(i * max, (i + 1) * max));
  return pack(
    s.split(separator).flatMap((p) => pieces(p, max, rest)),
    max,
  );
}

/** Join consecutive parts while they fit in `max`. */
function pack(parts: string[], max: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const p of parts) {
    if (current && current.length + p.length > max) {
      out.push(current);
      current = "";
    }
    current += p;
  }
  if (current) out.push(current);
  return out;
}
