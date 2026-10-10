// Bridge to Claude via the locally installed Claude Code CLI.
//
// `claude -p` uses whatever account the CLI is logged into, so a Pro/Max subscription
// works without an API key. Each call is one-shot, tool-less and returns JSON matching
// a schema. MCP servers, skills and user settings are disabled so per-call overhead
// stays around 1k tokens. Running the process itself is shared with Codex (./cli).

import { findBinary, runCli, type DiscoveredModel, type ModelList, type RequestOptions } from "./cli";
import type { ImageInput } from "./types";

export function findClaude(configured: string): string {
  return findBinary(configured, "claude", [".claude/local"]);
}

const RUN = { command: "claude", who: "Claude", product: "Claude Code" };

export function askClaude<T>(o: RequestOptions, system: string, prompt: string, schema: object, images: ImageInput[] = []): Promise<T> {
  // Images go in as content blocks via stream-json input; plain prompts use the simpler text mode.
  const streaming = images.length > 0;
  const args = [
    "-p",
    ...(streaming ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
    "--tools",
    "",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--system-prompt",
    system,
    "--json-schema",
    JSON.stringify(schema),
  ];
  if (o.model.trim()) args.push("--model", o.model.trim());
  if (o.effort?.trim()) args.push("--effort", o.effort.trim());
  return runCli({
    ...RUN,
    bin: findClaude(o.path),
    args,
    cwd: o.cwd,
    signal: o.signal,
    timeoutMs: o.timeoutMs ?? 300_000,
    timeoutMessage: "Claude took too long to answer (timed out).",
    inputErrors: true,
    // Prompts can contain whole notes, so send them over stdin, not argv.
    start: (stdin) => stdin.end(streaming ? userMessage(prompt, images) : prompt),
    onExit: ({ stdout, stderr, code }) => {
      const { data, models } = streaming ? parseStreamResult<T>(stdout, stderr, code) : parseResult<T>(stdout, stderr, code);
      if (models[0]) o.onModel?.(models[0]);
      return data;
    },
  });
}

/**
 * Ask the CLI which models it offers. This is only the SDK `initialize` handshake:
 * no prompt is sent, so it costs nothing against your limits.
 */
export function listClaudeModels(o: Pick<RequestOptions, "path" | "cwd" | "timeoutMs" | "signal">): Promise<ModelList> {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--setting-sources", "", "--no-session-persistence", "--strict-mcp-config"];
  return runCli({
    ...RUN,
    bin: findClaude(o.path),
    args,
    cwd: o.cwd,
    signal: o.signal,
    timeoutMs: o.timeoutMs ?? 30_000,
    timeoutMessage: "Claude Code took too long to list its models.",
    start: (stdin) => stdin.end(JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } }) + "\n"),
    // Stop as soon as the answer is in rather than waiting for the CLI to exit.
    onOutput: (stdout) => parseModelList(stdout) ?? undefined,
    onExit: ({ stdout, stderr, code }) => {
      const found = parseModelList(stdout);
      if (!found) throw new Error(`claude exited with code ${code}: ${stderr.trim() || "no model list"}`);
      return found;
    },
  });
}

/** The model list from the `initialize` control response, or null if it hasn't arrived. */
export function parseModelList(stdout: string): ModelList | null {
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let v: { type?: string; response?: { request_id?: string; response?: Record<string, unknown> } };
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (v.type !== "control_response" || v.response?.request_id !== "models") continue;
    const r = v.response.response ?? {};
    const raw = Array.isArray(r.models) ? (r.models as Record<string, unknown>[]) : [];
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    const models = raw
      .map((m) => ({
        provider: "claude" as const,
        id: str(m.value) === "default" ? "" : str(m.value),
        name: str(m.displayName),
        desc: str(m.description),
        resolved: str(m.resolvedModel),
      }))
      .filter((m) => m.id || m.resolved);
    return { version: str(r.claude_code_version), models };
  }
  return null;
}

/** Effort levels accepted by `claude --effort`. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** "claude-sonnet-5-5" → "Sonnet 5.5". Unknown formats are returned unchanged. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id.trim());
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** One stream-json user message with text and image content blocks. */
export function userMessage(prompt: string, images: ImageInput[]): string {
  const content = [
    { type: "text", text: prompt },
    ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } })),
  ];
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

/** stream-json output: many JSON lines; the last `result` line has the same shape as `--output-format json`. */
export function parseStreamResult<T>(stdout: string, stderr: string, code: number | null): { data: T; models: string[] } {
  const results = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((v): v is Record<string, unknown> => v?.type === "result");
  if (!results.length) {
    const msg = stderr.trim() || stdout.trim().slice(-500) || "no output";
    throw new Error(`claude exited with code ${code}: ${msg}`);
  }
  return interpret<T>(results[results.length - 1]);
}

export function parseResult<T>(stdout: string, stderr: string, code: number | null): { data: T; models: string[] } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    const msg = stderr.trim() || stdout.trim() || "no output";
    throw new Error(`claude exited with code ${code}: ${msg}`);
  }
  return interpret<T>(v);
}

function interpret<T>(v: Record<string, unknown>): { data: T; models: string[] } {
  if (v.is_error === true || v.subtype !== "success") {
    throw new Error(`Claude returned an error: ${typeof v.result === "string" ? v.result : "unknown error"}`);
  }
  const models = Object.keys((v.modelUsage as Record<string, unknown>) ?? {});
  if (v.structured_output != null) return { data: v.structured_output as T, models };
  const text = typeof v.result === "string" ? v.result : "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    // No structured reply at all: usually a plain message from Claude Code itself
    // (for example a model that isn't available on your plan). Show it as is.
    throw new Error(text.trim() ? `Claude: ${text.trim()}` : "Claude's reply wasn't valid JSON.");
  }
  try {
    return { data: JSON.parse(text.slice(start, end + 1)) as T, models };
  } catch {
    throw new Error(`Claude's reply wasn't valid JSON: ${text.trim().slice(0, 300)}`);
  }
}
