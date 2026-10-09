import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask } from "../src/core/claude";

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

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
