// Run a request, or list models, with whichever CLI the settings chose.

import { askClaude, listClaudeModels } from "./claude";
import type { ModelList, Provider, RequestOptions } from "./cli";
import { askCodex, listCodexModels } from "./codex";
import type { ImageInput } from "./types";

/** One structured request: the reply as JSON matching `schema`. */
export async function ask<T>(
  o: RequestOptions,
  system: string,
  prompt: string,
  schema: object,
  images: ImageInput[] = [],
): Promise<T> {
  const reply =
    o.provider === "codex"
      ? await askCodex<T>(o, system, prompt, schema, images)
      : await askClaude<T>(o, system, prompt, schema, images);
  // The CLIs enforce the schema, but a reply parsed from plain text isn't checked: don't let a
  // missing score turn into NaN in your progress.
  const wrong = mismatch(schema, reply);
  if (wrong !== null) {
    const who = o.provider === "codex" ? "Codex" : "Claude";
    throw new Error(`${who}'s reply was incomplete${wrong ? ` (\`${wrong}\` is missing or the wrong type)` : ""}.`);
  }
  return reply;
}

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

function hasType(type: string, v: unknown): boolean {
  switch (type) {
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return true;
  }
}

/**
 * Where a reply breaks its schema's types (`""` for the reply itself, else a path like
 * `gaps[1].fix`), or null if it doesn't. Enums and ranges are left to the code using the
 * reply, which clamps or falls back.
 */
export function mismatch(schema: Schema, v: unknown, at = ""): string | null {
  const types = [schema.type ?? []].flat();
  if (types.length && !types.some((t) => hasType(t, v))) return at;
  if (hasType("object", v) && schema.properties) {
    const o = v as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in o)) return at ? `${at}.${key}` : key;
    for (const [key, s] of Object.entries(schema.properties)) {
      if (!(key in o)) continue;
      const wrong = mismatch(s, o[key], at ? `${at}.${key}` : key);
      if (wrong !== null) return wrong;
    }
  }
  if (Array.isArray(v) && schema.items)
    for (const [i, x] of v.entries()) {
      const wrong = mismatch(schema.items, x, `${at}[${i}]`);
      if (wrong !== null) return wrong;
    }
  return null;
}

/** Which models a CLI offers. Costs nothing against your limits. */
export function listModels(
  provider: Provider,
  o: Pick<RequestOptions, "path" | "cwd" | "timeoutMs" | "signal">,
): Promise<ModelList> {
  return provider === "codex" ? listCodexModels(o) : listClaudeModels(o);
}
