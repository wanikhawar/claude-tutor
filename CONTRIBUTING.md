# Contributing to Claude Tutor

Thanks for helping out! Bug reports, fixes and ideas are all welcome.

## Reporting bugs and asking for features

Open an [issue](https://github.com/wanikhawar/claude-tutor/issues) and include:

- what you did, what you expected and what happened instead
- the versions of the plugin, Obsidian and Claude Code (or the Codex CLI), and your OS
- any errors from the developer console (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>, or <kbd>Cmd</kbd>+<kbd>Opt</kbd>+<kbd>I</kbd> on macOS)

Please leave out the contents of private notes; a small note that shows the problem is best.

**Security problems go through [private reporting](SECURITY.md), not public issues.**

For a large change or a new feature, open an issue first so we can agree on the approach before you spend time on it.

## Setting up

You need Node 22 (what CI uses), Obsidian desktop 1.13+, and Claude Code or the Codex CLI logged in.

```sh
git clone https://github.com/wanikhawar/claude-tutor.git
cd claude-tutor
npm install
```

Use a separate vault for development, not your real one. Link the repository into it and rebuild on save:

```sh
VAULT="/path/to/dev/vault"
ln -s "$PWD" "$VAULT/.obsidian/plugins/claude-tutor"
npm run dev
```

Enable **Claude Tutor** under **Settings → Community plugins**, and reload the plugin (or Obsidian) after a rebuild.
The [Hot-Reload](https://github.com/pjeby/hot-reload) plugin can do that for you.

## Checks

Before opening a pull request, make sure both of these pass. CI runs them on every pull request.

```sh
npm test        # unit tests
npm run build   # type-checks with svelte-check, then builds main.js
```

If you change prompts or how replies are parsed, also run the live test. It uses Claude Haiku and counts against your plan:

```sh
CLAUDE_LIVE=1 npx vitest run tests/live.test.ts
```

Add or update tests for what you change. Tests live in `tests/`; Obsidian's API is mocked in `tests/obsidian.mock.ts`.

## Code guidelines

The [Development](README.md#development) section of the README maps out the source. A few things to keep in mind:

- **Privacy is the point.** Only notes the user picked may be sent to the model, and the plugin makes no network
  requests of its own and has no telemetry. Replies are shown through `src/ui/lib/markdown.ts`, so nothing in them can
  load from the web; keep it that way, and add a test to `tests/markdown.test.ts` if you touch it.
- **Follow Obsidian's [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).** The plugin
  is reviewed against them: use `createEl` / `createDiv` rather than `document.createElement`, don't set
  `innerHTML`, avoid `any`, and use Obsidian's APIs for vault files.
- **`src/core/` stays plain TypeScript** with no `obsidian` import, so it can be tested without Obsidian.
- **Match the surrounding code**: its naming, its comment style (short comments that say why) and its formatting.
- **No new dependencies** without discussing them first; everything gets bundled into `main.js`.
- If you change what the plugin sends, runs or stores, update the **Disclosures** and **Data** sections of the README.

## Pull requests

- Keep each pull request to one change, and describe what it does and how you tested it.
- Add screenshots for UI changes, in light and dark mode.
- Write commit messages in the imperative, like the existing history ("Only read the notes you pick").
- Don't bump the version or edit `manifest.json` / `versions.json`; that happens at release time.

## Releases

Releases are made by the maintainer: the version is bumped in `manifest.json`, `package.json` and `versions.json`,
and pushing a tag with the same version (no `v`) runs `.github/workflows/release.yml`, which tests, builds, attests
and publishes `main.js`, `manifest.json` and `styles.css`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
