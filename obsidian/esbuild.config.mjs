import esbuild from "esbuild";
import sveltePlugin from "esbuild-svelte";
import builtins from "builtin-modules";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "node",
  outfile: "main.js",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  // Provided by Obsidian/Electron at runtime.
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins, ...builtins.map((m) => `node:${m}`)],
  mainFields: ["svelte", "browser", "module", "main"],
  conditions: ["svelte", "browser"],
  plugins: [sveltePlugin({ compilerOptions: { css: "injected" } })],
});

if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
