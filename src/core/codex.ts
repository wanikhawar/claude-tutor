// Bridge to OpenAI models via the locally installed Codex CLI.
//
// `codex exec` uses whatever account the CLI is logged into. Each call is one-shot and
// ephemeral, returns JSON matching a schema, and runs read-only with Codex's agent tools
// switched off: the tutor only needs the reply, and the tools roughly double the prompt.
// Running the process itself is shared with Claude Code (./cli).

import { existsSync } from "node:fs";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, findBinary, runCli, type DiscoveredModel, type ModelList, type RequestOptions } from "./cli";
import type { ImageInput } from "./types";

/** Features that only add agent tools; off, a request is about half the size. */
const TOOL_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "browser_use",
  "computer_use",
  "image_generation",
  "multi_agent",
  "plugins",
  "skill_search",
  "tool_suggest",
  "view_image",
  "goals",
  "sleep_tool",
  "hooks",
  "in_app_browser",
];

export function findCodex(configured: string): string {
  return findBinary(configured, "codex");
}

const RUN = { command: "codex", who: "Codex", product: "the Codex CLI" };

/**
 * A Codex home holding only your login. Codex always adds `$CODEX_HOME/AGENTS.md` to a
 * request and has no switch for it, so tutor requests run from a home without one.
 * Returns undefined when your real home can be used as is (it has no global instructions;
 * your skills are kept out by a flag on every request, whichever home it runs from).
 */
export async function isolatedHome(): Promise<string | undefined> {
  const real = process.env.CODEX_HOME || join(homedir(), ".codex");
  const global = ["AGENTS.override.md", "AGENTS.md"].some((f) => existsSync(join(real, f)));
  const auth = join(real, "auth.json");
  if (existsSync(auth)) {
    const home = await mkdtemp(join(tmpdir(), "claude-tutor-codex-home-"));
    // A link, not a copy: Codex rewrites auth.json in place when it renews your login,
    // and the renewed tokens have to land in the real file. Hard link if symlinks aren't allowed.
    for (const make of [symlink, link]) {
      try {
        await make(auth, join(home, "auth.json"));
        return home;
      } catch {
        // try the next kind of link
      }
    }
    await rm(home, { recursive: true, force: true });
  }
  if (!global) return undefined;
  throw new Error(
    `Codex would send your global instructions (${join(real, "AGENTS.md")}) with every tutor request, ` +
      "and the tutor can't keep them out because your Codex login isn't in auth.json. " +
      "Move or rename that file, or log Codex in with file-based credentials.",
  );
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** One structured request through `codex exec`. Same contract as `askClaude`. */
export async function askCodex<T>(o: RequestOptions, system: string, prompt: string, schema: object, images: ImageInput[] = []): Promise<T> {
  if (o.signal?.aborted) throw new Error("Codex request cancelled.");
  // Schema, instructions and images go in as files; the prompt goes over stdin.
  const dir = await mkdtemp(join(tmpdir(), "claude-tutor-codex-"));
  let home: string | undefined;
  try {
    home = await isolatedHome();
    const schemaFile = join(dir, "schema.json");
    const systemFile = join(dir, "instructions.md");
    await writeFile(schemaFile, JSON.stringify(schema));
    await writeFile(systemFile, system);
    const imageFiles = await Promise.all(
      images.map(async (im, i) => {
        const file = join(dir, `image-${i}.${EXT[im.mediaType] ?? "png"}`);
        await writeFile(file, Buffer.from(im.data, "base64"));
        return file;
      }),
    );
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      ...TOOL_FEATURES.flatMap((f) => ["--disable", f]),
      "-c",
      'web_search="disabled"',
      // Never read AGENTS.md files from the working directory up to the repo root: in a
      // Git-managed vault that would send notes you never picked.
      "-c",
      "project_doc_max_bytes=0",
      // Nor list your Codex skills: their descriptions would go along with every request.
      "-c",
      "skills.include_instructions=false",
      // Replaces Codex's coding-agent instructions with the tutor's.
      "-c",
      `model_instructions_file=${JSON.stringify(systemFile)}`,
      "--output-schema",
      schemaFile,
    ];
    if (o.model.trim()) args.push("--model", o.model.trim());
    if (o.effort?.trim()) args.push("-c", `model_reasoning_effort=${JSON.stringify(o.effort.trim())}`);
    for (const f of imageFiles) args.push("--image", f);
    // `--image` takes several files, so end the options before the stdin marker.
    args.push("--", "-");
    return await runCli({
      ...RUN,
      bin: findCodex(o.path),
      args,
      // Run inside the empty temp folder, so Codex's workspace holds nothing from the vault.
      cwd: dir,
      env: home ? { ...childEnv(), CODEX_HOME: home } : childEnv(),
      signal: o.signal,
      timeoutMs: o.timeoutMs ?? 300_000,
      timeoutMessage: "Codex took too long to answer (timed out).",
      inputErrors: true,
      start: (stdin) => stdin.end(prompt),
      onExit: ({ stdout, stderr, code }) => parseCodexResult<T>(stdout, stderr, code),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
    // Removes the link, never the login it points to.
    if (home) await rm(home, { recursive: true, force: true });
  }
}

/** `codex exec --json` prints JSONL events; the reply is the last agent message. */
export function parseCodexResult<T>(stdout: string, stderr: string, code: number | null): T {
  let reply: string | undefined;
  let failed: string | undefined;
  // `error` events also report retries Codex recovers from; only a failed turn or exit code is final.
  let lastError: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let v: { type?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string } };
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (v.type === "item.completed" && v.item?.type === "agent_message" && typeof v.item.text === "string") reply = v.item.text;
    if (v.type === "error" && v.message) lastError = v.message;
    if (v.type === "turn.failed") failed = v.error?.message ?? lastError ?? "the turn failed";
  }
  // An agent message can come before the turn fails, so a reply alone isn't success.
  if (reply === undefined || failed !== undefined || code !== 0) {
    const msg = failed ?? lastError ?? (stderr.trim().split("\n").slice(-3).join(" ") || "no output");
    throw new Error(code === 0 && failed ? `Codex returned an error: ${msg}` : `codex exited with code ${code}: ${msg}`);
  }
  try {
    return JSON.parse(reply) as T;
  } catch {
    throw new Error(reply.trim() ? `Codex: ${reply.trim().slice(0, 300)}` : "Codex's reply wasn't valid JSON.");
  }
}

/**
 * Ask Codex which models it offers, over the app-server protocol's `model/list`.
 * No conversation is started, so it costs nothing against your limits.
 */
export function listCodexModels(o: Pick<RequestOptions, "path" | "cwd" | "timeoutMs" | "signal">): Promise<ModelList> {
  const send = (stdin: NodeJS.WritableStream, msg: object) => stdin.write(JSON.stringify(msg) + "\n");
  // Pages of the list asked for so far; each reply may point to another.
  let requested = 1;
  return runCli({
    ...RUN,
    bin: findCodex(o.path),
    args: ["app-server"],
    cwd: o.cwd,
    signal: o.signal,
    timeoutMs: o.timeoutMs ?? 30_000,
    timeoutMessage: "Codex took too long to list its models.",
    start: (stdin) => {
      send(stdin, { id: 1, method: "initialize", params: { clientInfo: { name: "claude-tutor", title: "Claude Tutor", version: "1" }, capabilities: null } });
      send(stdin, { method: "initialized" });
      send(stdin, { id: 2, method: "model/list", params: {} });
    },
    onOutput: (stdout, stdin) => {
      const found = parseCodexModelList(stdout);
      if (!found) return undefined;
      if (found.next === null) return { version: found.version, models: found.models };
      if (found.pages < requested) return undefined;
      if (requested >= 50) throw new Error("Codex's model list didn't end.");
      requested++;
      send(stdin, { id: 1 + requested, method: "model/list", params: { cursor: found.next } });
      return undefined;
    },
    onExit: ({ stderr, code }) => {
      throw new Error(`codex exited with code ${code}: ${stderr.trim().split("\n").pop() || "no model list"}`);
    },
  });
}

type Reply = { id?: number; result?: Record<string, unknown>; error?: { message?: string } };

/**
 * The `model/list` pages that have arrived (request ids 2, 3, …) and the CLI version from
 * `initialize`, or null before the first page. `next` is the cursor for the page still to
 * fetch, null once the list is complete.
 */
export function parseCodexModelList(stdout: string): { version: string; models: DiscoveredModel[]; pages: number; next: string | null } | null {
  let version = "";
  const replies = new Map<number, Reply>();
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let v: Reply;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    // userAgent looks like "claude-tutor/0.161.0 (…)": the number is the Codex version.
    if (v.id === 1) version = /\/(\d[\w.-]*)/.exec(String(v.result?.userAgent ?? ""))?.[1] ?? "";
    else if (typeof v.id === "number") replies.set(v.id, v);
  }
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const models: DiscoveredModel[] = [];
  let pages = 0;
  let next: string | null = null;
  for (let v = replies.get(2); v; v = replies.get(2 + pages)) {
    if (v.error) throw new Error(`Codex couldn't list models: ${v.error.message ?? "unknown error"}`);
    const raw = Array.isArray(v.result?.data) ? (v.result.data as Record<string, unknown>[]) : [];
    for (const m of raw) {
      if (m.hidden === true || !str(m.model)) continue;
      models.push({ provider: "codex", id: str(m.model), name: str(m.displayName) || str(m.model), desc: str(m.description), resolved: str(m.model) });
    }
    pages++;
    next = str(v.result?.nextCursor) || null;
    if (!next) break;
  }
  return pages ? { version, models, pages, next } : null;
}
