// What the CLI adapters (Claude Code, Codex) share: the provider-neutral types, and
// running a CLI process with cancellation, a timeout and clean-up.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

export const str = (x: unknown) => (typeof x === "string" ? x : "");

/** The JSON objects in a CLI's line-by-line output; lines that aren't one are skipped. */
export function* jsonLines<T = Record<string, unknown>>(stdout: string): Generator<T> {
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let v: T;
    try {
      v = JSON.parse(line) as T;
    } catch {
      continue;
    }
    yield v;
  }
}

/** What a cancelled request fails with. Named like a DOM abort, so the UI can tell it from a failure. */
export function cancelled(who: string): Error {
  const e = new Error(`${who} request cancelled.`);
  e.name = "AbortError";
  return e;
}

const WINDOWS = process.platform === "win32";

/** Where the CLIs install themselves. */
function installDirs(homeDirs: string[]): string[] {
  const home = homedir();
  if (WINDOWS) {
    // The native installers use ~\.local\bin; npm puts its .cmd shims in %APPDATA%\npm.
    const npm = process.env.APPDATA ? [join(process.env.APPDATA, "npm")] : [];
    return [...[".local/bin", ...homeDirs].map((d) => join(home, d)), ...npm, join(home, ".bun/bin")];
  }
  return [
    ...[".local/bin", ...homeDirs, ".npm-global/bin", ".bun/bin"].map((d) => join(home, d)),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

/** GUI apps often start without the user's shell PATH, so look in the usual install spots. */
export function findBinary(configured: string, name: string, homeDirs: string[] = []): string {
  if (configured.trim()) return configured.trim();
  if (!WINDOWS)
    return (
      installDirs(homeDirs)
        .map((d) => join(d, name))
        .find((c) => existsSync(c)) ?? name
    );
  // spawn() only finds .exe files on PATH by itself, and npm installs .cmd shims, so search PATH too.
  const dirs = [...installDirs(homeDirs), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
  const candidates = dirs.flatMap((d) => [join(d, `${name}.exe`), join(d, `${name}.cmd`)]);
  return candidates.find((c) => existsSync(c)) ?? name;
}

export function childEnv(): NodeJS.ProcessEnv {
  return withPath(WINDOWS ? installDirs([]) : [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]);
}

/** The environment with `dirs` put in front of PATH. */
export function withPath(dirs: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Windows spells it "Path"; adding a second "PATH" would leave which one counts to chance.
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[key] = [...dirs, env[key] ?? ""].join(delimiter);
  return env;
}

/**
 * What to spawn to run `bin`. Node only runs a Windows .cmd through cmd.exe, which can't pass
 * arguments with newlines (like Claude's system prompt) intact, so an npm shim is run as the
 * `node <script>` it wraps.
 */
export function launcher(bin: string, args: string[]): { file: string; args: string[] } {
  if (!WINDOWS || !/\.(cmd|bat)$/i.test(bin) || !existsSync(bin)) return { file: bin, args };
  // npm's shims end with: "%_prog%"  "%dp0%\node_modules\<package>\cli.js" %*
  const target = /"%~?dp0%?\\([^"]+)"\s+%\*/.exec(readFileSync(bin, "utf8"))?.[1];
  if (!target)
    throw new Error(`Can't run "${bin}": only npm's .cmd shims are supported. Set the path to the .exe instead.`);
  const dir = dirname(bin);
  const script = join(dir, target);
  if (!/\.[cm]?js$/i.test(script)) return { file: script, args };
  // Like the shim: a node.exe next to it if there is one, otherwise the one on PATH.
  const node = join(dir, "node.exe");
  return { file: existsSync(node) ? node : "node", args: [script, ...args] };
}

/** Stop a CLI. On Windows kill() ends only that process, so a shim's node would leave the CLI it started running. */
function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (WINDOWS && child.pid !== undefined) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("error", () => child.kill());
  } else child.kill();
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
    if (r.signal?.aborted) return reject(cancelled(r.who));
    let run: { file: string; args: string[] };
    try {
      run = launcher(r.bin, r.args);
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    const child = spawn(run.file, run.args, { cwd: r.cwd, env: r.env ?? childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      r.signal?.removeEventListener("abort", abort);
      stop(child);
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
    const abort = () => fail(cancelled(r.who));
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
