import { defineConfig } from "vitest/config";
import { compile, compileModule } from "svelte/compiler";
import ts from "typescript";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Happy DOM, unlike a browser, loads frames, stylesheets and scripts even in the inert document
    // replies are rendered into, so tests of untrusted HTML would fetch what it points at. This stops
    // that loading; it doesn't block a fetch() a test makes itself.
    environmentOptions: {
      happyDOM: {
        settings: { disableIframePageLoading: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
      },
    },
  },
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./tests/obsidian.mock.ts", import.meta.url)) },
    conditions: ["browser"],
  },
  plugins: [
    {
      name: "svelte-tests",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith(".svelte")) {
          return compile(code, { filename: id, generate: "client", css: "injected", dev: true }).js;
        }
        if (id.endsWith(".svelte.ts")) {
          const js = ts.transpileModule(code, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
          }).outputText;
          return compileModule(js, { filename: id, generate: "client", dev: true }).js;
        }
      },
    },
  ],
});
