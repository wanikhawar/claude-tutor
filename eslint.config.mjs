// The rules Obsidian's plugin review runs, so CI catches what a reviewer would flag.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "node_modules/", "test-vault/", "tests/", "scripts/", "**/*.svelte"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "vitest.config.ts"],
        },
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
    files: ["**/*.svelte.ts"],
    languageOptions: {
      globals: { $state: "readonly", $derived: "readonly", $effect: "readonly", $props: "readonly" },
    },
  },
]);
