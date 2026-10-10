// Run a request, or list models, with whichever CLI the settings chose.

import { askClaude, listClaudeModels } from "./claude";
import type { ModelList, Provider, RequestOptions } from "./cli";
import { askCodex, listCodexModels } from "./codex";
import type { ImageInput } from "./types";

/** One structured request: the reply as JSON matching `schema`. */
export function ask<T>(o: RequestOptions, system: string, prompt: string, schema: object, images: ImageInput[] = []): Promise<T> {
  return o.provider === "codex" ? askCodex<T>(o, system, prompt, schema, images) : askClaude<T>(o, system, prompt, schema, images);
}

/** Which models a CLI offers. Costs nothing against your limits. */
export function listModels(provider: Provider, o: Pick<RequestOptions, "path" | "cwd" | "timeoutMs" | "signal">): Promise<ModelList> {
  return provider === "codex" ? listCodexModels(o) : listClaudeModels(o);
}
