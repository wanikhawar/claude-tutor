import { homedir } from "node:os";
import { App, PluginSettingTab, Setting, TFolder, requireApiVersion, type SettingDefinitionItem } from "obsidian";
import type ClaudeTutorPlugin from "./main";
import { findClaude, modelLabel } from "./core/claude";

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
  model: string;
  /** `--effort` level; empty = Claude Code's default. */
  effort: string;
  /** The exact model each alias last resolved to, learned from Claude's replies. */
  resolvedModels: Record<string, string>;
  claudePath: string;
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
  model: "sonnet",
  effort: "",
  // Current models behind each alias; updated automatically from real replies.
  resolvedModels: {
    haiku: "claude-haiku-5-5",
    sonnet: "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
    fable: "claude-fable-5-1",
  },
  claudePath: "",
  explainPerSession: 2,
  quizQuestions: 4,
  openInSidebar: false,
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
  constructor(
    app: App,
    private plugin: ClaudeTutorPlugin,
  ) {
    super(app, plugin);
  }

  /** The settings, defined once and rendered by either Obsidian API below. */
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
      setting.addSlider((sl) => {
        sl.setLimits(min, max, 1)
          .setValue(get())
          .onChange(async (v) => {
            set(v);
            await save();
          });
        // 1.13+ always shows the value next to the slider; older versions need the tooltip.
        if (!requireApiVersion("1.13.0")) sl.setDynamicTooltip();
      });

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
                  this.display();
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
            desc: "When you change a note, Clawd re-reads it in the background (one Claude request per note).",
            build: (setting) =>
              setting.addToggle((t) =>
                t.setValue(s.autoIndex).onChange(async (v) => {
                  s.autoIndex = v;
                  await save();
                }),
              ),
          },
          {
            name: "Ask before reading many notes",
            desc: "Confirm first when more than this many notes need reading at once.",
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
            desc: "Runs through your Claude Code login, so it uses your subscription.",
            build: (setting) =>
              setting.addDropdown((d) =>
                d
                  .addOptions(Object.fromEntries(MODEL_CHOICES.map((m) => [m.id, `${resolvedName(s, m.id)}: ${m.hint}`])))
                  .setValue(s.model)
                  .onChange(async (v) => {
                    s.model = v;
                    await save();
                  }),
              ),
          },
          {
            name: "Effort",
            desc: "How hard Claude thinks. Higher is slower and uses more of your limits.",
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
            desc: "Open Claude Tutor in the right sidebar instead of a tab.",
            build: (setting) =>
              setting.addToggle((t) =>
                t.setValue(s.openInSidebar).onChange(async (v) => {
                  s.openInSidebar = v;
                  await save();
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
        ],
      },
    ];
  }

  /** Obsidian 1.13+: declarative settings, so they show up in settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.sections().map((sec) => ({
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
  }

  /** Older Obsidian (before 1.13) renders the same rows imperatively. */
  display() {
    if (requireApiVersion("1.13.0")) return super.display();
    const el = this.containerEl;
    el.empty();
    for (const sec of this.sections()) {
      new Setting(el).setName(sec.heading).setHeading();
      for (const row of sec.rows) {
        if (row.visible && !row.visible()) continue;
        const setting = new Setting(el).setName(row.name);
        if (row.desc) setting.setDesc(row.desc);
        row.build(setting);
      }
    }
  }
}

export const MODEL_CHOICES = [
  { id: "haiku", hint: "fastest, lightest on usage" },
  { id: "sonnet", hint: "balanced" },
  { id: "opus", hint: "deepest explanations" },
  { id: "fable", hint: "may need usage credits on your plan" },
  { id: "", hint: "whatever claude uses by default" },
];

export const EFFORT_CHOICES = [
  { id: "", name: "Default", hint: "Claude Code's default" },
  { id: "low", name: "Low", hint: "quickest answers" },
  { id: "medium", name: "Medium", hint: "a bit more thought" },
  { id: "high", name: "High", hint: "careful reasoning" },
  { id: "xhigh", name: "Extra high", hint: "very thorough" },
  { id: "max", name: "Max", hint: "deepest thinking, slowest" },
];

/** "Sonnet 5.5", or "Default (Opus 5.5)" once we've seen what the default resolves to. */
export function resolvedName(s: TutorSettings, alias: string): string {
  const id = s.resolvedModels[alias];
  if (!alias) return id ? `Default (${modelLabel(id)})` : "Default";
  return id ? modelLabel(id) : alias[0].toUpperCase() + alias.slice(1);
}

function lines(v: string): string[] {
  return v
    .split("\n")
    .map((l) => l.trim().replace(/\/+$/, "") || (l.trim() ? "/" : ""))
    .filter(Boolean);
}
