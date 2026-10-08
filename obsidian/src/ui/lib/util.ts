import type { Concept } from "./api";

export function masteryColor(c: Concept): string {
  if (!c.last_reviewed) return "var(--text-3)";
  if (c.mastery < 0.4) return "var(--bad)";
  if (c.mastery < 0.8) return "var(--warn)";
  return "var(--good)";
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
