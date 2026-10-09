import { App, PluginSettingTab, Setting, TFolder } from "obsidian";
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

export class TutorSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: ClaudeTutorPlugin,
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl: el } = this;
    const s = this.plugin.settings;
    const excludedBefore = [...s.excludedFolders];
    const filesBefore = [...s.studyFiles];
    const save = async (rescan = false) => {
      await this.plugin.saveSettings();
      if (rescan) await this.plugin.backend.rescan();
    };
    el.empty();

    new Setting(el).setName("What to study").setHeading();
    new Setting(el)
      .setName("Study folders")
      .setDesc('One folder per line. Use "/" for the whole vault. Clawd reads Markdown notes (and PDFs) inside them.')
      .addTextArea((t) =>
        t
          .setPlaceholder("Courses/Networking\nPapers")
          .setValue(s.studyFolders.join("\n"))
          .onChange(async (v) => {
            s.studyFolders = lines(v);
            await save(true);
          }),
      );
    new Setting(el)
      .setName("Excluded folders")
      .setDesc("One per line. Notes in these folders are never read.")
      .addTextArea((t) =>
        t
          .setPlaceholder("Templates\nArchive")
          .setValue(s.excludedFolders.join("\n"))
          .onChange(async (v) => {
            applyExclusions(s, excludedBefore, filesBefore, lines(v));
            await save(true);
          }),
      );
    new Setting(el)
      .setName("Include PDFs")
      .setDesc("Extract text from PDFs (uses pdftotext if installed, otherwise Obsidian's built-in PDF reader). Scanned PDFs without a text layer are skipped.")
      .addToggle((t) =>
        t.setValue(s.includePdfs).onChange(async (v) => {
          s.includePdfs = v;
          await save(true);
        }),
      );
    if (s.studyFiles.length) {
      new Setting(el)
        .setName("Individually added notes")
        .setDesc(s.studyFiles.join(", "))
        .addButton((b) =>
          b.setButtonText("Clear").onClick(async () => {
            s.studyFiles = [];
            await save(true);
            this.display();
          }),
        );
    }

    new Setting(el).setName("Reading").setHeading();
    new Setting(el)
      .setName("Re-read notes after edits")
      .setDesc("When you change a note, Clawd re-reads it in the background (one Claude request per note).")
      .addToggle((t) =>
        t.setValue(s.autoIndex).onChange(async (v) => {
          s.autoIndex = v;
          await save();
        }),
      );
    new Setting(el)
      .setName("Ask before reading many notes")
      .setDesc("Confirm first when more than this many notes need reading at once.")
      .addText((t) =>
        t.setValue(String(s.confirmAbove)).onChange(async (v) => {
          s.confirmAbove = Math.max(1, Number(v) || DEFAULT_SETTINGS.confirmAbove);
          await save();
        }),
      );

    new Setting(el).setName("Tutor").setHeading();
    new Setting(el)
      .setName("Model")
      .setDesc("Runs through your Claude Code login, so it uses your subscription.")
      .addDropdown((d) =>
        d
          .addOptions(
            Object.fromEntries(
              MODEL_CHOICES.map((m) => [m.id, `${resolvedName(s, m.id)}: ${m.hint}`]),
            ),
          )
          .setValue(s.model)
          .onChange(async (v) => {
            s.model = v;
            await save();
          }),
      );
    new Setting(el)
      .setName("Effort")
      .setDesc("How hard Claude thinks. Higher is slower and uses more of your limits.")
      .addDropdown((d) =>
        d
          .addOptions(Object.fromEntries(EFFORT_CHOICES.map((e) => [e.id, `${e.name}: ${e.hint}`])))
          .setValue(s.effort)
          .onChange(async (v) => {
            s.effort = v;
            await save();
          }),
      );
    new Setting(el)
      .setName("Concepts to explain per session")
      .addSlider((sl) =>
        sl
          .setLimits(0, 5, 1)
          .setValue(s.explainPerSession)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.explainPerSession = v;
            await save();
          }),
      );
    new Setting(el)
      .setName("Quiz questions per session")
      .addSlider((sl) =>
        sl
          .setLimits(0, 10, 1)
          .setValue(s.quizQuestions)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.quizQuestions = v;
            await save();
          }),
      );
    new Setting(el)
      .setName("Open in right sidebar")
      .setDesc("Open Claude Tutor in the right sidebar instead of a tab.")
      .addToggle((t) =>
        t.setValue(s.openInSidebar).onChange(async (v) => {
          s.openInSidebar = v;
          await save();
        }),
      );

    new Setting(el)
      .setName("Lesson notes folder")
      .setDesc("Where the Teach tab saves lessons when you click “Save as note”.")
      .addText((t) =>
        t
          .setPlaceholder("Claude Tutor/Lessons")
          .setValue(s.lessonFolder)
          .onChange(async (v) => {
            s.lessonFolder = v.trim();
            await save();
          }),
      );

    new Setting(el).setName("Advanced").setHeading();
    new Setting(el)
      .setName("Path to claude")
      .setDesc(`Leave empty to auto-detect (currently: ${findClaude("")}).`)
      .addText((t) =>
        t
          .setPlaceholder("~/.local/bin/claude")
          .setValue(s.claudePath)
          .onChange(async (v) => {
            s.claudePath = v.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~");
            await save();
          }),
      );
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
