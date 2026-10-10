import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listClaudeModels as listModels, parseModelList } from "../src/core/claude";
import { ask } from "../src/core/providers";
import { runCli } from "../src/core/cli";
import { askCodex, listCodexModels, parseCodexModelList, parseCodexResult } from "../src/core/codex";
import { Backend } from "../src/backend";
import { fixture } from "./helpers";

let dir: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

async function executable(code: string) {
  dir = await mkdtemp(join(tmpdir(), "claude-tutor-test-"));
  const path = join(dir, "claude");
  await writeFile(path, `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
  return { path, model: "", cwd: dir, timeoutMs: 5000 };
}

describe("Claude process lifecycle", () => {
  it("rejects orderly when a CLI exits before reading a large image payload", async () => {
    const opts = await executable("process.exit(1)");
    await expect(ask(opts, "System", "Prompt", {}, [{ mediaType: "image/png", data: "a".repeat(8_000_000) }]))
      .rejects.toThrow(/Couldn't send input|exited with code/);
  });

  it("cancels a running request and does not report a later model response", async () => {
    const opts = await executable("process.stdin.resume(); setInterval(() => {}, 1000)");
    const controller = new AbortController();
    const onModel = vi.fn();
    const request = ask({ ...opts, signal: controller.signal, onModel }, "System", "Prompt", {});
    controller.abort();
    await expect(request).rejects.toThrow("cancelled");
    expect(onModel).not.toHaveBeenCalled();
  });

  it("does not launch an already-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(ask({ path: "/not/a/claude/binary", model: "", cwd: tmpdir(), signal: controller.signal }, "", "", {})).rejects.toThrow("cancelled");
  });
});

describe("model discovery", () => {
  const response = (models: object[]) =>
    JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "models", response: { claude_code_version: "2.1.296", models } } });

  it("reads the model list from the initialize handshake and maps the default to an empty id", () => {
    const out = `{"type":"system"}\nnot json\n${response([
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Efficient" },
    ])}\n`;
    expect(parseModelList(out)).toEqual({
      version: "2.1.296",
      models: [
        { provider: "claude", id: "", name: "Default (recommended)", desc: "Opus 5.5", resolved: "claude-opus-5-5" },
        { provider: "claude", id: "sonnet", name: "Sonnet 5.5", desc: "Efficient", resolved: "claude-sonnet-5-5" },
      ],
    });
    expect(parseModelList('{"type":"system"}\n')).toBeNull();
  });

  it("sends only the initialize request, never a prompt", async () => {
    const reply = response([{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" }]);
    const opts = await executable(`
      let input = "";
      process.stdin.on("data", (d) => (input += d));
      process.stdin.on("end", () => {
        const lines = input.trim().split("\\n").map((l) => JSON.parse(l));
        if (lines.length !== 1 || lines[0].request.subtype !== "initialize") process.exit(3);
        console.log(${JSON.stringify(reply)});
      });`);
    const found = await listModels(opts);
    expect(found.models.map((m) => m.id)).toEqual(["opus"]);
  });

  it("reports a CLI that exits without a model list", async () => {
    await expect(listModels(await executable("process.exit(2)"))).rejects.toThrow(/exited with code 2/);
  });
});

describe("Codex CLI", () => {
  it("reads visible models and the CLI version from the app-server replies", () => {
    const out = [
      JSON.stringify({ id: 1, result: { userAgent: "claude-tutor/0.161.0 (Linux)" } }),
      JSON.stringify({
        id: 2,
        result: {
          data: [
            { id: "gpt-6-sol", model: "gpt-6-sol", displayName: "GPT-6-Sol", description: "Smart", hidden: false },
            { id: "secret", model: "secret", displayName: "Secret", description: "", hidden: true },
          ],
          nextCursor: null,
        },
      }),
    ].join("\n");
    expect(parseCodexModelList(out)).toEqual({
      version: "0.161.0",
      models: [{ provider: "codex", id: "gpt-6-sol", name: "GPT-6-Sol", desc: "Smart", resolved: "gpt-6-sol" }],
      pages: 1,
      next: null,
    });
    expect(parseCodexModelList(JSON.stringify({ id: 1, result: {} }))).toBeNull();
    expect(() => parseCodexModelList(JSON.stringify({ id: 2, error: { message: "not logged in" } }))).toThrow("not logged in");
  });

  it("takes the last agent message as the reply and surfaces failed turns", () => {
    const events = (...e: object[]) => e.map((x) => JSON.stringify(x)).join("\n");
    const ok = events({ type: "thread.started" }, { type: "item.completed", item: { type: "agent_message", text: '{"answer":"hi"}' } }, { type: "turn.completed" });
    expect(parseCodexResult<{ answer: string }>(ok, "", 0)).toEqual({ answer: "hi" });
    const failed = events({ type: "turn.failed", error: { message: "model not supported on your plan" } });
    expect(() => parseCodexResult(failed, "", 1)).toThrow("model not supported on your plan");
  });

  it("never accepts a reply from a turn that then failed", () => {
    const events = (...e: object[]) => e.map((x) => JSON.stringify(x)).join("\n");
    const early = { type: "item.completed", item: { type: "agent_message", text: '{"answer":"draft"}' } };
    const failed = events(early, { type: "error", message: "stream disconnected" }, { type: "turn.failed", error: { message: "stream disconnected" } });
    expect(() => parseCodexResult(failed, "", 1)).toThrow("codex exited with code 1: stream disconnected");
    expect(() => parseCodexResult(failed, "", 0)).toThrow("Codex returned an error: stream disconnected");
    expect(() => parseCodexResult(events(early), "killed", 1)).toThrow("codex exited with code 1: killed");
    // A retry Codex recovered from is not a failure.
    const recovered = events({ type: "error", message: "Reconnecting... 1/5" }, early, { type: "turn.completed" });
    expect(parseCodexResult(recovered, "", 0)).toEqual({ answer: "draft" });
  });

  it("lists models without starting a conversation", async () => {
    const opts = await executable(`
      const rl = require("node:readline").createInterface({ input: process.stdin });
      rl.on("line", (l) => {
        const m = JSON.parse(l);
        if (m.method === "thread/start" || m.method === "turn/start") process.exit(3);
        if (m.id === 1) console.log(JSON.stringify({ id: 1, result: { userAgent: "x/0.161.0" } }));
        if (m.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ model: "gpt-6-sol", displayName: "GPT-6-Sol", hidden: false }] } }));
      });`);
    const found = await listCodexModels(opts);
    expect(found.models.map((m) => m.id)).toEqual(["gpt-6-sol"]);
  });

  it("follows the list across pages", async () => {
    const opts = await executable(`
      const rl = require("node:readline").createInterface({ input: process.stdin });
      const pages = { "": { data: [{ model: "gpt-6-sol" }], nextCursor: "page-2" }, "page-2": { data: [{ model: "gpt-6-mini" }], nextCursor: null } };
      rl.on("line", (l) => {
        const m = JSON.parse(l);
        if (m.id === 1) console.log(JSON.stringify({ id: 1, result: { userAgent: "x/0.162.1" } }));
        if (m.method === "model/list") console.log(JSON.stringify({ id: m.id, result: pages[m.params.cursor ?? ""] }));
      });`);
    const found = await listCodexModels(opts);
    expect(found).toEqual({ version: "0.162.1", models: [expect.objectContaining({ id: "gpt-6-sol" }), expect.objectContaining({ id: "gpt-6-mini" })] });
  });

  it("runs codex exec read-only, without agent tools, with the schema, model, effort and images", async () => {
    const opts = await executable(`
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      const val = (flag) => args[args.indexOf(flag) + 1];
      let input = "";
      process.stdin.on("data", (d) => (input += d));
      process.stdin.on("end", () => {
        const report = {
          input,
          sandbox: val("--sandbox"),
          model: val("--model"),
          shellOff: args.includes("shell_tool"),
          effort: args.find((a) => a.startsWith("model_reasoning_effort")),
          schema: JSON.parse(fs.readFileSync(val("--output-schema"), "utf8")),
          instructions: fs.readFileSync(JSON.parse(args.find((a) => a.startsWith("model_instructions_file=")).split("=").slice(1).join("=")), "utf8"),
          image: fs.readFileSync(val("--image")).toString(),
          projectDocsOff: args.includes("project_doc_max_bytes=0"),
          skillsOff: args.includes("skills.include_instructions=false"),
          tail: args.slice(-2),
          workspace: fs.readdirSync(process.cwd()).sort(),
          home: fs.readdirSync(process.env.CODEX_HOME),
          login: fs.readFileSync(process.env.CODEX_HOME + "/auth.json", "utf8"),
        };
        // Renew the login the way Codex does: rewrite auth.json in place.
        fs.writeFileSync(process.env.CODEX_HOME + "/auth.json", "renewed");
        console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(report) } }));
      });`);
    const real = join(opts.cwd, "codex-home");
    await mkdir(real);
    await writeFile(join(real, "auth.json"), "token");
    await writeFile(join(real, "AGENTS.md"), "Private global instructions");
    vi.stubEnv("CODEX_HOME", real);
    const reply = await ask<Record<string, unknown>>(
      { ...opts, provider: "codex", model: "gpt-6-sol", effort: "high" },
      "Be Clawd",
      "Explain it",
      { type: "object" },
      [{ mediaType: "image/png", data: Buffer.from("PNGDATA").toString("base64") }],
    );
    expect(reply).toEqual({
      // Codex runs from a home holding only the login, never the global AGENTS.md.
      home: ["auth.json"],
      login: "token",
      input: "Explain it",
      sandbox: "read-only",
      model: "gpt-6-sol",
      shellOff: true,
      effort: 'model_reasoning_effort="high"',
      schema: { type: "object" },
      instructions: "Be Clawd",
      image: "PNGDATA",
      // Never AGENTS.md from the vault: no project docs, and an empty temp folder as the workspace.
      projectDocsOff: true,
      skillsOff: true,
      workspace: ["image-0.png", "instructions.md", "schema.json"],
      // `--image` is variadic; without `--` it would swallow the stdin marker.
      tail: ["--", "-"],
    });
    // The renewal reached the real file, and cleaning up removed only the link.
    expect(await readFile(join(real, "auth.json"), "utf8")).toBe("renewed");
    expect((await readdir(real)).sort()).toEqual(["AGENTS.md", "auth.json"]);
  });

  it("refuses rather than send global instructions it can't keep out", async () => {
    const opts = await executable("process.exit(3)");
    const real = join(opts.cwd, "codex-home");
    await mkdir(real);
    await writeFile(join(real, "AGENTS.md"), "Private global instructions");
    vi.stubEnv("CODEX_HOME", real);
    await expect(askCodex(opts, "System", "Prompt", {})).rejects.toThrow(/global instructions/);
  });

  it("uses the real Codex home when there are no global instructions to keep out", async () => {
    const opts = await executable(`
      process.stdin.resume();
      process.stdin.on("end", () => console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ home: process.env.CODEX_HOME }) } })));`);
    const real = join(opts.cwd, "codex-home");
    await mkdir(real);
    vi.stubEnv("CODEX_HOME", real);
    expect(await askCodex(opts, "System", "Prompt", {})).toEqual({ home: real });
  });

  it("stops listing models when cancelled", async () => {
    const opts = await executable("process.stdin.resume(); setInterval(() => {}, 1000)");
    const controller = new AbortController();
    const listing = listCodexModels({ ...opts, signal: controller.signal });
    controller.abort();
    await expect(listing).rejects.toThrow("cancelled");
  });

  it("doesn't save discovered models after the backend is disposed", async () => {
    const reply = [JSON.stringify({ id: 1, result: { userAgent: "x/0.161.0" } }), JSON.stringify({ id: 2, result: { data: [{ model: "gpt-6-sol" }] } })];
    const opts = await executable(`
      process.stdin.resume();
      setTimeout(() => { console.log(${JSON.stringify(reply.join("\n"))}); }, 300);`);
    const f = fixture();
    f.settings.codexPath = opts.path;
    const save = vi.fn(async () => {});
    const backend = new Backend(f.app, f.library, f.progress, () => f.settings, opts.cwd, () => {}, save);
    const discovery = backend.discoverModels("codex");
    backend.dispose();
    await expect(discovery).rejects.toThrow("cancelled");
    await new Promise((r) => setTimeout(r, 400));
    expect(save).not.toHaveBeenCalled();
    expect(f.settings.discovered).toEqual([]);
  });
});

describe("shared CLI runner", () => {
  const base = { command: "tool", who: "Tool", product: "Tool CLI", timeoutMs: 5000, timeoutMessage: "Tool timed out.", start: (stdin: NodeJS.WritableStream) => stdin.end() };

  it("explains a missing CLI and how to fix it", async () => {
    await expect(runCli({ ...base, bin: "/not/a/tool", args: [], cwd: tmpdir(), onExit: () => "never" }))
      .rejects.toThrow('Couldn\'t find the `tool` command (looked for "/not/a/tool"). Install Tool CLI or set its path in the plugin settings.');
  });

  it("times out a CLI that never answers", async () => {
    const opts = await executable("process.stdin.resume(); setInterval(() => {}, 1000)");
    await expect(runCli({ ...base, bin: opts.path, args: [], cwd: opts.cwd, timeoutMs: 200, start: () => {}, onExit: () => "never" })).rejects.toThrow("Tool timed out.");
  });

  it("stops the CLI as soon as the output has the answer", async () => {
    const opts = await executable(`console.log("ready"); setTimeout(() => process.exit(0), 5000);`);
    const started = Date.now();
    const onExit = vi.fn(() => "exited");
    const result = await runCli({ ...base, bin: opts.path, args: [], cwd: opts.cwd, onOutput: (out) => (out.includes("ready") ? "early" : undefined), onExit });
    expect(result).toBe("early");
    expect(onExit).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("keeps characters whole when the output splits them across chunks", async () => {
    // "中文" is six bytes; each stream gets four, a pause, then the last two.
    const opts = await executable(`
      const bytes = Buffer.from("中文");
      process.stdout.write(bytes.subarray(0, 4)); process.stderr.write(bytes.subarray(0, 4));
      setTimeout(() => { process.stdout.write(bytes.subarray(4)); process.stderr.write(bytes.subarray(4)); }, 200);`);
    const result = await runCli({ ...base, bin: opts.path, args: [], cwd: opts.cwd, onExit: ({ stdout, stderr }) => `${stdout}|${stderr}` });
    expect(result).toBe("中文|中文");
  });
});
