// The rules Obsidian's plugin review runs, so CI catches what a reviewer would flag.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

// Obsidian's config only covers .ts and .js files; components get the same rules as .ts.
const forTs = (files) => files.some((f) => (Array.isArray(f) ? forTs(f) : f.startsWith("**/*.{ts,")));
const forSvelte = obsidianmd.configs.recommended
  .filter((c) => c.files && forTs(c.files))
  .map((c) => ({ ...c, files: ["**/*.svelte"] }));
// Svelte's own rules come without a file pattern and break on package.json.
const SVELTE = ["**/*.svelte", "**/*.svelte.ts"];
const svelteRules = svelte.configs.recommended.map((c) => (c.files || !c.rules ? c : { ...c, files: SVELTE }));

export default defineConfig([
  { ignores: ["main.js", "node_modules/", "test-vault/", "tests/", "scripts/"] },
  ...obsidianmd.configs.recommended,
  ...forSvelte,
  ...svelteRules,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "vitest.config.ts"],
        },
        extraFileExtensions: [".svelte"],
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["Claude Tutor", "Clawd", "Claude", "Codex", "Markdown", "PDFs"],
          acronyms: ["PDF"],
          // Placeholders that are example paths, like "Courses/Networking".
          ignoreRegex: ["[/\\n]"],
        },
      ],
    },
  },
  {
    files: SVELTE,
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
    rules: {
      // Keys only matter for lists whose items move; a wrong one is worse than none.
      "svelte/require-each-key": "off",
      // Plain Maps and Sets here are built inside $derived or are bookkeeping no template reads.
      "svelte/prefer-svelte-reactivity": "off",
      // Disagrees with the compiler: it calls svelte-ignore comments unused that svelte-check needs.
      "svelte/no-unused-svelte-ignore": "off",
    },
  },
  {
    files: ["**/*.svelte"],
    rules: {
      // ESLint sees imported components as `any`, so these misfire on every prop callback.
      // svelte-check type-checks templates against the real component types instead.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    files: ["**/*.svelte.ts"],
    languageOptions: {
      globals: { $state: "readonly", $derived: "readonly", $effect: "readonly", $props: "readonly" },
    },
  },
]);
