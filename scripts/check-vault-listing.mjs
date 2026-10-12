// Fails if a whole-vault listing is added, moved or removed without updating the README's
// "Lists your vault's files" disclosure. Obsidian's plugin review flags these calls, so each
// one has to be expected and disclosed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// File → number of listing calls in it. Keep in step with the README disclosure.
const allowed = {
  "src/library.ts": 1, // Library.candidates(): the notes in the study folders
  "src/backend.ts": 1, // Backend.folderSummary(): note counts on the first-run screen
  "src/ui/lib/pickers.ts": 3, // NotePicker, FolderPicker, ImagePicker
  "src/main.ts": 1, // folder rename handler in registerVaultEvents()
};

const listing = /\.\s*(getFiles|getMarkdownFiles|getAllLoadedFiles|getAllFolders)\s*\(/g;

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.(ts|svelte)$/.test(entry.name)) yield path;
  }
}

const problems = [];
const seen = new Set();
for (const path of sources("src")) {
  const count = [...readFileSync(path, "utf8").matchAll(listing)].length;
  if (count === 0) continue;
  seen.add(path);
  if (allowed[path] !== count) problems.push(`${path}: ${count} vault listing call(s), expected ${allowed[path] ?? 0}`);
}
for (const path of Object.keys(allowed)) {
  if (!seen.has(path)) problems.push(`${path}: expected ${allowed[path]} vault listing call(s), found none`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(
    "\nWhole-vault listings must be disclosed. Prefer a narrower lookup (getAbstractFileByPath(), a folder's children," +
      " Vault.recurseChildren()); if a listing is really needed, update the README's \"Lists your vault's files\"" +
      " disclosure and the counts in scripts/check-vault-listing.mjs.",
  );
  process.exit(1);
}
console.log("Vault listings match the disclosure.");
