import type { Concept } from "./api";

export type MasteryLevel = "new" | "shaky" | "getting" | "solid";

/** The one place mastery thresholds live. */
export function masteryLevel(c: Concept): MasteryLevel {
  if (!c.last_reviewed) return "new";
  if (c.mastery < 0.4) return "shaky";
  if (c.mastery < 0.8) return "getting";
  return "solid";
}

const LEVEL_COLOR: Record<MasteryLevel, string> = {
  new: "var(--text-3)",
  shaky: "var(--bad)",
  getting: "var(--warn)",
  solid: "var(--good)",
};

export function masteryColor(c: Concept): string {
  return LEVEL_COLOR[masteryLevel(c)];
}

export function scoreColor(score: number): string {
  if (score >= 80) return "var(--good)";
  if (score >= 50) return "var(--warn)";
  return "var(--bad)";
}

export function relativeDue(c: Concept): string {
  if (!c.due) return "new";
  const ms = new Date(c.due).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const h = ms / 3_600_000;
  if (h < 1) return "in a few minutes";
  if (h < 24) return `in ${Math.round(h)}h`;
  const d = Math.round(h / 24);
  return d === 1 ? "tomorrow" : `in ${d} days`;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Burning the midnight oil";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** The one send rule for every composer. */
export const SEND_HINT = "Enter to send · Shift+Enter for a new line";

/** Composer keydown: Enter (or Ctrl/Cmd+Enter) sends, Shift+Enter adds a line. */
export function enterToSend(e: KeyboardEvent, send: () => void) {
  if (e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing) return;
  e.preventDefault();
  // Keep Obsidian's own Mod+Enter hotkey and the view's handlers from firing too.
  e.stopPropagation();
  send();
}

/** "3 days ago" for an ISO timestamp. */
export function timeAgo(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return new Date(iso).toLocaleDateString();
}

const DRAFT = "claude-tutor-draft:";

/** Unsent text, kept per vault in Obsidian's local storage so a closed view doesn't lose it. */
export function loadDraft(app: { loadLocalStorage?: (k: string) => unknown } | undefined, key: string): string {
  try {
    const v = app?.loadLocalStorage?.(DRAFT + key);
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

export function saveDraft(app: { saveLocalStorage?: (k: string, v: unknown) => void } | undefined, key: string, text: string) {
  try {
    app?.saveLocalStorage?.(DRAFT + key, text.trim() ? text : null);
  } catch {
    // Drafts are a convenience; never let storage break the composer.
  }
}
