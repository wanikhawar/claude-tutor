// What the CLI adapters (Claude Code, Codex) share: the provider-neutral types, and
// running a CLI process with cancellation, a timeout and clean-up.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";

/** Which CLI runs a request: Claude Code, or OpenAI's Codex CLI. */
export type Provider = "claude" | "codex";
export const PROVIDERS: { id: Provider; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex CLI" },
];

export interface RequestOptions {
  /** Which CLI to run; default Claude Code. */
  provider?: Provider;
  /** Path to that CLI's binary; empty = auto-detect. */
  path: string;
  /** Model for `--model` (an alias like "sonnet", or a full id); empty = CLI default. */
  model: string;
  /** Effort level (low, medium, high, xhigh, max); empty = CLI default. */
  effort?: string;
  /** Told which exact model answered (e.g. "claude-sonnet-5-5"). */
  onModel?: (id: string) => void;
  /** Neutral working directory, so no project instruction files are picked up. */
  cwd: string;
  /** Kill the request after this long. */
  timeoutMs?: number;
  /** Cancel the request when its owner is disposed. */
  signal?: AbortSignal;
}

/** A model a CLI offers, as reported by the CLI itself. */
export interface DiscoveredModel {
  provider: Provider;
  /** What to pass to `--model`; empty = the CLI's default. */
  id: string;
  name: string;
  desc: string;
  /** The exact model the id currently points at, e.g. "claude-opus-5-5". */
  resolved: string;
}

export type ModelList = { version: string; models: DiscoveredModel[] };

/** GUI apps often start without the user's shell PATH, so look in the usual install spots. */
export function findBinary(configured: string, name: string, homeDirs: string[] = []): string {
  if (configured.trim()) return configured.trim();
  const home = homedir();
  const candidates = [
    ...[".local/bin", ...homeDirs, ".npm-global/bin", ".bun/bin"].map((d) => join(home, d, name)),
    ...["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map((d) => join(d, name)),
  ];
  return candidates.find((c) => existsSync(c)) ?? name;
}

export function childEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const extra = [join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ""].join(":") };
}

export interface CliRun<T> {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** For messages: the command ("claude"), and who's talking ("Claude"). */
  command: string;
  who: string;
  /** Named in the "couldn't find it" hint, e.g. "Claude Code". */
  product: string;
  signal?: AbortSignal;
  timeoutMs: number;
  timeoutMessage: string;
  /** Send the input. stdin may stay open for a conversation (see `onOutput`). */
  start: (stdin: Writable) => void;
  /** Called with all output so far after each chunk; return a result to stop the CLI early. */
  onOutput?: (stdout: string, stdin: Writable) => T | undefined;
  /** The CLI exited before `onOutput` had a result. Return it from the output, or throw. */
  onExit: (out: { stdout: string; stderr: string; code: number | null }) => T;
  /** A failed write to stdin fails the run; otherwise the exit code tells what happened. */
  inputErrors?: boolean;
}

/** Run a CLI once. Settles exactly once: with a result, or on failure, cancellation or timeout. */
export function runCli<T>(r: CliRun<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (r.signal?.aborted) return reject(new Error(`${r.who} request cancelled.`));
    const child = spawn(r.bin, r.args, { cwd: r.cwd, env: r.env ?? childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      r.signal?.removeEventListener("abort", abort);
      child.kill();
      settle();
    };
    const fail = (e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    const attempt = (get: () => T | undefined) => {
      try {
        const result = get();
        if (result !== undefined) finish(() => resolve(result));
      } catch (e) {
        fail(e);
      }
    };
    const abort = () => fail(new Error(`${r.who} request cancelled.`));
    const timer = window.setTimeout(() => fail(new Error(r.timeoutMessage)), r.timeoutMs);
    r.signal?.addEventListener("abort", abort, { once: true });

    // Decode as streams: a character split across two chunks must not turn into U+FFFD.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      if (r.onOutput && !settled) attempt(() => r.onOutput!(stdout, child.stdin));
    });
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) =>
      fail(
        new Error(
          e.code === "ENOENT"
            ? `Couldn't find the \`${r.command}\` command (looked for "${r.bin}"). Install ${r.product} or set its path in the plugin settings.`
            : `Couldn't launch ${r.command}: ${e.message}`,
        ),
      ),
    );
    // stdin is a separate stream: a CLI that exits early can raise EPIPE while we're still writing.
    child.stdin.on("error", (e: Error) => {
      if (r.inputErrors) fail(new Error(`Couldn't send input to ${r.command}: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      try {
        const result = r.onExit({ stdout, stderr, code });
        finish(() => resolve(result));
      } catch (e) {
        fail(e);
      }
    });
    r.start(child.stdin);
  });
}
