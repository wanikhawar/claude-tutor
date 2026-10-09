// Bridge to Claude via the locally installed Claude Code CLI.
//
// `claude -p` uses whatever account the CLI is logged into, so a Pro/Max subscription
// works without an API key. Each call is one-shot, tool-less and returns JSON matching
// a schema. MCP servers, skills and user settings are disabled so per-call overhead
// stays around 1k tokens.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImageInput } from "./types";

export interface ClaudeOptions {
  /** Path to the `claude` binary; empty = auto-detect. */
  path: string;
  /** Model alias for `--model` ("sonnet", "opus", "haiku", "fable"); empty = CLI default. */
  model: string;
  /** `--effort` level (low, medium, high, xhigh, max); empty = CLI default. */
  effort?: string;
  /** Told which exact model answered (e.g. "claude-sonnet-5-5"). */
  onModel?: (id: string) => void;
  /** Neutral working directory so no project CLAUDE.md is picked up. */
  cwd: string;
  /** Kill the request after this long. */
  timeoutMs?: number;
  /** Cancel the request when its owner is disposed. */
  signal?: AbortSignal;
}

/** GUI apps often start without the user's shell PATH, so look in the usual install spots. */
export function findClaude(configured: string): string {
  if (configured.trim()) return configured.trim();
  const home = homedir();
  const candidates = [
    join(home, ".local/bin/claude"),
    join(home, ".claude/local/claude"),
    join(home, ".npm-global/bin/claude"),
    join(home, ".bun/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  return candidates.find((c) => existsSync(c)) ?? "claude";
}

function childEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const extra = [join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ""].join(":") };
}

export function ask<T>(o: ClaudeOptions, system: string, prompt: string, schema: object, images: ImageInput[] = []): Promise<T> {
  if (o.signal?.aborted) return Promise.reject(new Error("Claude request cancelled."));
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

  return new Promise((resolve, reject) => {
    const bin = findClaude(o.path);
    const child = spawn(bin, args, { cwd: o.cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const cleanup = () => {
      settled = true;
      window.clearTimeout(timer);
      o.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      child.kill();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const abort = () => fail(new Error("Claude request cancelled."));
    const timer = window.setTimeout(() => fail(new Error("Claude took too long to answer (timed out).")), o.timeoutMs ?? 300_000);
    o.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      fail(
        new Error(
          e.code === "ENOENT"
            ? `Couldn't find the \`claude\` command (looked for "${bin}"). Install Claude Code or set its path in the plugin settings.`
            : `Couldn't launch claude: ${e.message}`,
        ),
      );
    });
    // stdin is a separate stream: early CLI exits can emit EPIPE while sending images.
    child.stdin.on("error", (e: Error) => fail(new Error(`Couldn't send input to claude: ${e.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      try {
        const { data, models } = streaming ? parseStreamResult<T>(out, err, code) : parseResult<T>(out, err, code);
        if (models[0]) o.onModel?.(models[0]);
        cleanup();
        resolve(data);
      } catch (e) {
        fail(e);
      }
    });
    if (o.signal?.aborted) return abort();
    // Prompts can contain whole notes, so send them over stdin, not argv.
    child.stdin.end(streaming ? userMessage(prompt, images) : prompt);
  });
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
