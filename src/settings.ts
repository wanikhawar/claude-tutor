import { homedir } from "node:os";
import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFolder, type SettingDefinition, type SettingDefinitionItem, type SettingDefinitionPage } from "obsidian";
import type ClaudeTutorPlugin from "./main";
import { findClaude, modelLabel } from "./core/claude";
import { PROVIDERS, type DiscoveredModel, type Provider } from "./core/cli";
import { findCodex } from "./core/codex";

/** A model shown in the picker, with an optional display name of your own. */
export interface VisibleModel {
  provider: Provider;
  id: string;
  alias: string;
}

export interface TutorSettings {
  /** Folders to study ("/" = whole vault). Empty = not set up yet. */
  studyFolders: string[];
  /** Individual notes added with "Study this note". */
  studyFiles: string[];
  excludedFolders: string[];
  includePdfs: boolean;
  /** Re-read notes automatically after you edit them. */
  autoIndex: boolean;
  /** Ask before reading more than this many notes at once. */
  confirmAbove: number;
  /** Which CLI runs the tutor, and the model passed to it. */
  provider: Provider;
  model: string;
  /** Models offered in the picker, in order. Never empty. */
  models: VisibleModel[];
  /** What each CLI last said it offers (empty until it has been asked). */
  discovered: DiscoveredModel[];
  versions: Partial<Record<Provider, string>>;
  /** Effort level, one of EFFORT_CHOICES. */
  effort: string;
  /** The exact model each alias last resolved to, learned from Claude's replies. */
  resolvedModels: Record<string, string>;
  claudePath: string;
  codexPath: string;
  explainPerSession: number;
  quizQuestions: number;
  openInSidebar: boolean;
  /** Where "Save as note" puts finished lessons from the Teach tab. */
  lessonFolder: string;
}

export const DEFAULT_SETTINGS: TutorSettings = {
  studyFolders: [],
  studyFiles: [],
  excludedFolders: [],
  includePdfs: true,
  autoIndex: true,
  confirmAbove: 25,
  provider: "claude",
  model: "sonnet",
  models: [
    { provider: "claude", id: "opus", alias: "" },
    { provider: "claude", id: "sonnet", alias: "" },
    { provider: "claude", id: "haiku", alias: "" },
  ],
  discovered: [],
  versions: {},
  effort: "medium",
  // Current models behind each alias; updated automatically from real replies.
  resolvedModels: {
    haiku: "claude-haiku-5-5",
    sonnet: "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
    fable: "claude-fable-5-1",
  },
  claudePath: "",
  codexPath: "",
  explainPerSession: 2,
  quizQuestions: 4,
  openInSidebar: true,
  lessonFolder: "Claude Tutor/Lessons",
};

export function allFolders(app: App): string[] {
  return app.vault
    .getAllLoadedFiles()
    .filter((f): f is TFolder => f instanceof TFolder)
    .map((f) => (f.isRoot() ? "/" : f.path))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Set the excluded folders. Whichever came last wins: a note added on its own stays in scope
 * inside an already excluded folder, but excluding a folder afterwards drops the notes in it.
 * `excludedBefore`/`filesBefore` are the lists from when editing began, so half-typed folder
 * names don't permanently remove notes.
 */
export function applyExclusions(s: TutorSettings, excludedBefore: string[], filesBefore: string[], next: string[]) {
  const added = next.filter((f) => !excludedBefore.includes(f));
  const under = (path: string) => added.some((f) => f === "/" || path === f || path.startsWith(f + "/"));
  const addedSince = s.studyFiles.filter((f) => !filesBefore.includes(f));
  s.excludedFolders = next;
  s.studyFiles = [...filesBefore.filter((f) => !under(f)), ...addedSince];
}

/** One settings row: its name and description, plus a builder that adds its control. */
interface Row {
  name: string;
  desc?: string;
  /** Hide the row when this returns false. */
  visible?: () => boolean;
  build: (setting: Setting) => unknown;
}
interface Section {
  heading: string;
  rows: Row[];
}

export class TutorSettingTab extends PluginSettingTab {
  /** Model discovery per CLI: asked once per settings session, or again from the reload button. */
  private discovery: Record<Provider, "idle" | "running" | "done"> = { claude: "idle", codex: "idle" };
  private discoveryError: Record<Provider, string> = { claude: "", codex: "" };

  constructor(
    app: App,
    private plugin: ClaudeTutorPlugin,
  ) {
    super(app, plugin);
  }

  private async discover(p: Provider) {
    if (this.discovery[p] === "running") return;
    this.discovery[p] = "running";
    this.discoveryError[p] = "";
    this.update();
    try {
      await this.plugin.backend.discoverModels(p);
    } catch (e) {
      this.discoveryError[p] = e instanceof Error ? e.message : String(e);
    }
    this.discovery[p] = "done";
    this.update();
  }

  /** Change the visible list, then save and redraw. */
  private async editModels(change: (models: VisibleModel[]) => void) {
    const s = this.plugin.settings;
    change(s.models);
    ensureModels(s);
    // Redraw before saving: Obsidian already shows the new order, and the next drag's
    // row numbers must match the list the callbacks read.
    this.update();
    await this.plugin.saveSettings();
  }

  /** One CLI: its status, the models it shows in the picker (reorder, alias, remove), and a page to browse them all. */
  private providerDefinitions(p: Provider): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const name = providerName(p);
    const known = knownModels(s, p);
    const mine = s.models.filter((m) => m.provider === p);
    const shown = (id: string) => s.models.some((m) => isModel(m, p, id));
    const keepOne = () => new Notice("Keep at least one model visible.");
    const custom = p === "claude" ? s.claudePath : s.codexPath;

    const status: SettingDefinition = {
      name: s.versions[p] ? `${name} v${s.versions[p]}` : name,
      render: (setting) => {
        // Ask on first render, so merely loading the plugin never spawns a CLI.
        if (this.discovery[p] === "idle") window.setTimeout(() => void this.discover(p));
        const error = this.discoveryError[p];
        setting.setDesc(
          this.discovery[p] === "running"
            ? "Checking which models are available…"
            : error
              ? `Couldn't list models: ${error}`
              : `${custom ? "Custom path" : "Auto-detected"} · ${mine.length} of ${known.length} models shown. Checking doesn't use your limits.`,
        );
        if (error) setting.descEl.addClass("mod-warning");
        setting.addExtraButton((b) =>
          b
            .setIcon("refresh-cw")
            .setTooltip("Reload models")
            .setDisabled(this.discovery[p] === "running")
            .onClick(() => void this.discover(p)),
        );
      },
    };

    const browse: SettingDefinitionPage = {
      type: "page",
      // Obsidian tells pages apart by name, so each CLI's needs its own.
      name: `Browse ${name} models`,
      desc: `Everything ${name} offers. Turn a model on to add it to the picker.`,
      displayValue: () => `${known.length} available`,
      items: [
        {
          type: "group",
          items: known.map((m) => ({
            name: baseName(s, p, m.id),
            desc: [m.desc, m.id || "default"].filter(Boolean).join(" · "),
            render: (setting: Setting) => {
              setting.addToggle((t) =>
                t.setValue(shown(m.id)).onChange(async (on) => {
                  if (!on && s.models.length === 1 && shown(m.id)) {
                    t.setValue(true);
                    return keepOne();
                  }
                  await this.editModels((list) => {
                    if (on && !shown(m.id)) list.push({ provider: p, id: m.id, alias: "" });
                    if (!on) list.splice(list.findIndex((v) => isModel(v, p, m.id)), 1);
                  });
                }),
              );
            },
          })),
        },
      ],
    };

    // The picker groups models by CLI, so order only matters within one; keep this CLI's last.
    const reorder = (next: VisibleModel[]) => (list: VisibleModel[]) => list.splice(0, list.length, ...list.filter((m) => m.provider !== p), ...next);

    return [
      { type: "group", heading: name, items: [status, browse] },
      {
        type: "list",
        heading: `${name} models in the picker (${mine.length})`,
        cls: "ct-model-list",
        emptyState: `None. Add one with + or Browse models.`,
        items: mine.map((m) => ({
          name: baseName(s, p, m.id),
          desc: createFragment((f) => {
            f.createEl("code", { text: m.id || "default" });
            if (isModel(m, s.provider, s.model)) f.createSpan({ cls: "ct-model-badge", text: "In use" });
          }),
          render: (setting: Setting) => {
            setting.addText((t) =>
              t
                .setPlaceholder("Alias (optional)")
                .setValue(m.alias)
                .onChange(async (v) => {
                  m.alias = v.trim();
                  await this.plugin.saveSettings();
                }),
            );
          },
        })),
        // `mine` is the list as drawn; another edit may land before the redraw, so act on the
        // current list by model id rather than rebuilding it from that snapshot.
        onReorder: (from, to) => {
          const id = mine[from]?.id;
          void this.editModels((list) => {
            const next = list.filter((m) => m.provider === p);
            const at = next.findIndex((m) => m.id === id);
            if (at < 0) return;
            next.splice(Math.min(to, next.length - 1), 0, ...next.splice(at, 1));
            reorder(next)(list);
          });
        },
        onDelete: (i) => {
          const id = mine[i]?.id;
          if (id === undefined) return;
          if (s.models.length === 1) return keepOne();
          void this.editModels((list) => {
            const at = list.findIndex((m) => isModel(m, p, id));
            if (at >= 0) list.splice(at, 1);
          });
        },
        addItem: {
          name: "Add a model",
          action: () => {
            const hidden = known.filter((m) => !shown(m.id));
            if (!hidden.length) return new Notice(known.length ? "Every available model is already visible." : `No ${name} models found yet. Try reloading.`);
            new AddModelModal(this.app, hidden, (m) => baseName(s, p, m.id), (m) => void this.editModels((list) => list.push({ provider: p, id: m.id, alias: "" }))).open();
          },
        },
      },
    ];
  }

  /** The settings, grouped into sections. */
  private sections(): Section[] {
    const s = this.plugin.settings;
    // Folder lists as they were when the tab opened, so half-typed names don't drop notes.
    const excludedBefore = [...s.excludedFolders];
    const filesBefore = [...s.studyFiles];
    const save = async (rescan = false) => {
      await this.plugin.saveSettings();
      if (rescan) await this.plugin.backend.rescan();
    };
    const slider = (min: number, max: number, get: () => number, set: (v: number) => void) => (setting: Setting) =>
      setting.addSlider((sl) =>
        sl
          .setLimits(min, max, 1)
          .setValue(get())
          .onChange(async (v) => {
            set(v);
            await save();
          }),
      );

    return [
      {
        heading: "What to study",
        rows: [
          {
            name: "Study folders",
            desc: 'One folder per line. Use "/" for the whole vault. Clawd reads Markdown notes (and PDFs) inside them.',
            build: (setting) =>
              setting.addTextArea((t) =>
                t
                  .setPlaceholder("Courses/Networking\nPapers")
                  .setValue(s.studyFolders.join("\n"))
                  .onChange(async (v) => {
                    s.studyFolders = lines(v);
                    await save(true);
                  }),
              ),
          },
          {
            name: "Excluded folders",
            desc: "One per line. Notes in these folders are never read.",
            build: (setting) =>
              setting.addTextArea((t) =>
                t
                  .setPlaceholder("Templates\nArchive")
                  .setValue(s.excludedFolders.join("\n"))
                  .onChange(async (v) => {
                    applyExclusions(s, excludedBefore, filesBefore, lines(v));
                    await save(true);
                  }),
              ),
          },
          {
            name: "Include PDFs",
            desc: "Extract text from PDFs (uses pdftotext if installed, otherwise Obsidian's built-in PDF reader). Scanned PDFs without a text layer are skipped.",
            build: (setting) =>
              setting.addToggle((t) =>
                t.setValue(s.includePdfs).onChange(async (v) => {
                  s.includePdfs = v;
                  await save(true);
                }),
              ),
          },
          {
            name: "Individually added notes",
            visible: () => s.studyFiles.length > 0,
            build: (setting) =>
              setting.setDesc(s.studyFiles.join(", ")).addButton((b) =>
                b.setButtonText("Clear").onClick(async () => {
                  s.studyFiles = [];
                  await save(true);
                  // Re-checks `visible`, which hides this row now the list is empty.
                  this.refreshDomState();
                }),
              ),
          },
        ],
      },
      {
        heading: "Reading",
        rows: [
          {
            name: "Re-read notes after edits",
            desc: "When you change a note, Clawd re-reads it in the background (one tutor request per note).",
            build: (setting) =>
              setting.addToggle((t) =>
                t.setValue(s.autoIndex).onChange(async (v) => {
                  s.autoIndex = v;
                  await save();
                }),
              ),
          },
          {
            name: "Ask before re-reading many notes",
            desc: "Confirm first when more than this many edited notes need re-reading at once.",
            build: (setting) =>
              setting.addText((t) =>
                t.setValue(String(s.confirmAbove)).onChange(async (v) => {
                  s.confirmAbove = Math.max(1, Number(v) || DEFAULT_SETTINGS.confirmAbove);
                  await save();
                }),
              ),
          },
        ],
      },
      {
        heading: "Tutor",
        rows: [
          {
            name: "Model",
            desc: "Runs through your Claude Code or Codex login, so it uses your subscription. Choose which models appear here in the sections above.",
            build: (setting) =>
              setting.addDropdown((d) =>
                d
                  .addOptions(Object.fromEntries(s.models.map((m) => [`${m.provider}:${m.id}`, `${modelName(s, m.provider, m.id)} (${providerName(m.provider)})`])))
                  .setValue(`${s.provider}:${s.model}`)
                  .onChange(async (v) => {
                    const at = v.indexOf(":");
                    s.provider = v.slice(0, at) as Provider;
                    s.model = v.slice(at + 1);
                    await save();
                  }),
              ),
          },
          {
            name: "Effort",
            desc: "How hard the model thinks. Higher is slower and uses more of your limits.",
            build: (setting) =>
              setting.addDropdown((d) =>
                d
                  .addOptions(Object.fromEntries(EFFORT_CHOICES.map((e) => [e.id, `${e.name}: ${e.hint}`])))
                  .setValue(s.effort)
                  .onChange(async (v) => {
                    s.effort = v;
                    await save();
                  }),
              ),
          },
          {
            name: "Concepts to explain per session",
            build: slider(0, 5, () => s.explainPerSession, (v) => (s.explainPerSession = v)),
          },
          {
            name: "Quiz questions per session",
            build: slider(0, 10, () => s.quizQuestions, (v) => (s.quizQuestions = v)),
          },
          {
            name: "Open in right sidebar",
            desc: "Keep Claude Tutor in the right sidebar, where it resizes with the sidebar. Turn off to open it in a tab.",
            build: (setting) =>
              setting.addToggle((t) =>
                t.setValue(s.openInSidebar).onChange(async (v) => {
                  s.openInSidebar = v;
                  await save();
                  // Move an open tutor view to its new place.
                  await this.plugin.placeView();
                }),
              ),
          },
          {
            name: "Lesson notes folder",
            desc: "Where the Teach tab saves lessons when you click “Save as note”.",
            build: (setting) =>
              setting.addText((t) =>
                t
                  .setPlaceholder("Claude Tutor/Lessons")
                  .setValue(s.lessonFolder)
                  .onChange(async (v) => {
                    s.lessonFolder = v.trim();
                    await save();
                  }),
              ),
          },
        ],
      },
      {
        heading: "Advanced",
        rows: [
          {
            name: "Path to claude",
            desc: `Leave empty to auto-detect (currently: ${findClaude("")}).`,
            build: (setting) =>
              setting.addText((t) =>
                t
                  .setPlaceholder("~/.local/bin/claude")
                  .setValue(s.claudePath)
                  .onChange(async (v) => {
                    s.claudePath = v.trim().replace(/^~(?=\/)/, homedir());
                    await save();
                  }),
              ),
          },
          {
            name: "Path to codex",
            desc: `Leave empty to auto-detect (currently: ${findCodex("")}).`,
            build: (setting) =>
              setting.addText((t) =>
                t
                  .setPlaceholder("/usr/bin/codex")
                  .setValue(s.codexPath)
                  .onChange(async (v) => {
                    s.codexPath = v.trim().replace(/^~(?=\/)/, homedir());
                    await save();
                  }),
              ),
          },
        ],
      },
    ];
  }

  /** Declarative settings (Obsidian 1.13+), so they show up in settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const groups: SettingDefinitionItem[] = this.sections().map((sec) => ({
      type: "group" as const,
      heading: sec.heading,
      items: sec.rows.map((row) => ({
        name: row.name,
        desc: row.desc,
        visible: row.visible,
        render: (setting: Setting) => {
          setting.setName(row.name);
          if (row.desc) setting.setDesc(row.desc);
          row.build(setting);
        },
      })),
    }));
    // Models sit just before the Tutor section, whose model dropdown they feed.
    const at = groups.findIndex((g) => "heading" in g && g.heading === "Tutor");
    groups.splice(at, 0, ...PROVIDERS.flatMap((p) => this.providerDefinitions(p.id)));
    return groups;
  }
}

class AddModelModal extends FuzzySuggestModal<DiscoveredModel> {
  constructor(
    app: App,
    private models: DiscoveredModel[],
    private name: (m: DiscoveredModel) => string,
    private onPick: (m: DiscoveredModel) => void,
  ) {
    super(app);
    this.setPlaceholder("Add a model to the picker…");
  }

  getItems(): DiscoveredModel[] {
    return this.models;
  }

  getItemText(m: DiscoveredModel): string {
    return `${this.name(m)} (${m.id || "default"})`;
  }

  onChooseItem(m: DiscoveredModel) {
    this.onPick(m);
  }
}

/** Used until Claude Code has been asked what it offers. */
export const BUILTIN_MODELS: DiscoveredModel[] = [
  { provider: "claude", id: "", name: "Default", desc: "Whatever Claude Code uses by default", resolved: "" },
  { provider: "claude", id: "opus", name: "Opus", desc: "Deepest explanations", resolved: "" },
  { provider: "claude", id: "sonnet", name: "Sonnet", desc: "Balanced", resolved: "" },
  { provider: "claude", id: "haiku", name: "Haiku", desc: "Fastest, lightest on usage", resolved: "" },
  { provider: "claude", id: "fable", name: "Fable", desc: "May need usage credits on your plan", resolved: "" },
];

export const providerName = (p: Provider) => PROVIDERS.find((x) => x.id === p)?.name ?? p;

export const isModel = (m: { provider: Provider; id: string }, provider: Provider, id: string) => m.provider === provider && m.id === id;

/** Everything a CLI offers, plus models you picked that it no longer lists. */
export function knownModels(s: TutorSettings, provider: Provider): DiscoveredModel[] {
  const found = s.discovered.filter((m) => m.provider === provider);
  const known = found.length || provider !== "claude" ? found : BUILTIN_MODELS;
  const missing = s.models
    .filter((v) => v.provider === provider && !known.some((m) => m.id === v.id))
    .map((v) => ({ provider, id: v.id, name: "", desc: `Not offered by ${providerName(provider)} any more`, resolved: "" }));
  return [...known, ...missing];
}

/** The model's own name, ignoring any alias: "Opus 5.5", "Default (Opus 5.5)", "GPT-6-Sol". */
export function baseName(s: TutorSettings, provider: Provider, id: string): string {
  if (provider === "claude" && !id) return resolvedName(s, id);
  const found = s.discovered.find((m) => isModel(m, provider, id));
  if (found?.name) return found.name;
  return provider === "claude" ? resolvedName(s, id) : id;
}

/** What the picker shows for a model: your alias, or its own name. */
export function modelName(s: TutorSettings, provider: Provider, id: string): string {
  return s.models.find((m) => isModel(m, provider, id))?.alias || baseName(s, provider, id);
}

/** Keep the visible list non-empty and the current model on it. */
export function ensureModels(s: TutorSettings) {
  if (!s.models.length) s.models = DEFAULT_SETTINGS.models.map((m) => ({ ...m }));
  if (!s.models.some((m) => isModel(m, s.provider, s.model))) {
    s.provider = s.models[0].provider;
    s.model = s.models[0].id;
  }
}

export const EFFORT_CHOICES = [
  { id: "low", name: "Low", hint: "quickest answers" },
  { id: "medium", name: "Medium", hint: "a bit more thought" },
  { id: "high", name: "High", hint: "careful reasoning" },
  { id: "xhigh", name: "Extra high", hint: "very thorough" },
  { id: "max", name: "Max", hint: "deepest thinking, slowest" },
];

/** "Sonnet 5.5", or "Default (Opus 5.5)" once we've seen what the default resolves to. */
export function resolvedName(s: TutorSettings, alias: string): string {
  const id = s.resolvedModels[alias] ?? (alias.startsWith("claude-") ? alias : "");
  if (!alias) return id ? `Default (${modelLabel(id)})` : "Default";
  return id ? modelLabel(id) : alias[0].toUpperCase() + alias.slice(1);
}

function lines(v: string): string[] {
  return v
    .split("\n")
    .map((l) => l.trim().replace(/\/+$/, "") || (l.trim() ? "/" : ""))
    .filter(Boolean);
}
