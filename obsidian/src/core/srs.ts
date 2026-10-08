// SM-2 style spaced repetition.
import type { Concept } from "./types";

export function isNew(c: Concept) {
  return !c.last_reviewed;
}

export function isDue(c: Concept, now = Date.now()) {
  return !c.due || new Date(c.due).getTime() <= now;
}

/** Update scheduling from a 0..1 performance score (mutates and returns `c`). */
export function review(c: Concept, score: number, now = new Date()): Concept {
  score = Math.min(1, Math.max(0, score));
  const q = Math.round(score * 5);
  if (q < 3) {
    c.reps = 0;
    c.lapses += 1;
    c.interval_days = 0;
    c.ease = Math.max(1.3, c.ease - 0.2);
    c.due = new Date(now.getTime() + 10 * 60_000).toISOString();
  } else {
    c.reps += 1;
    c.interval_days = c.reps === 1 ? 1 : c.reps === 2 ? 3 : Math.max(1, c.interval_days * c.ease);
    c.ease = Math.max(1.3, c.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    c.due = new Date(now.getTime() + c.interval_days * 86_400_000).toISOString();
  }
  c.mastery = isNew(c) ? score : c.mastery * 0.6 + score * 0.4;
  c.last_reviewed = now.toISOString();
  return c;
}
