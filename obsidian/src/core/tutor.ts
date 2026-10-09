// The teaching brain: prompts, JSON schemas and calls for every request made to Claude.

import { ask, type ClaudeOptions } from "./claude";
import type {
  ImageInput,
  TeachReply,
  ChatReply,
  CheckResult,
  Concept,
  ExtractedConcept,
  FeynmanEval,
  Gap,
  Grade,
  Question,
  QuizSet,
} from "./types";
import { isMcq } from "./types";

/** Moods Claude may pick for the mascot. The app adds idle/thinking/sleepy itself. */
export const MOODS = ["happy", "celebrating", "encouraging", "concerned", "curious", "proud", "confused"];

export const PERSONA = `You are Clawd, a warm, witty, slightly nerdy AI tutor: a small orange pixel creature who wears glasses. You teach with the Feynman technique: the learner explains ideas in plain words, you find the gaps, re-teach only those gaps simply, and have them explain again.

Rules:
- Notes extracted from PDFs contain \`[Page N]\` markers. When you quote or rely on one, cite the page (e.g. "(p. 12)") so the learner can look it up. Only cite pages for text under a \`[Page N]\` marker; never mention pages for other notes. Ignore leftover PDF artifacts like headers, footers and page numbers.
- Ground everything in the learner's own notes. Prefer their terminology and quote them briefly when useful. If you add anything the notes don't contain, label it clearly with "Beyond your notes:".
- Be concise, concrete and kind, but honest. Never praise a wrong answer. Never be condescending.
- Use analogies, tiny worked examples, and Markdown (short paragraphs, bullet lists, \`code\`, tables when helpful). For processes or relationships you may include a small ASCII diagram in a code block.
- Write ALL mathematics in LaTeX, in every field (including short ones like options and fixes): inline as $...$ and display equations as $$...$$ on their own lines. Never use \\( \\) or \\[ \\], Unicode math symbols, or plain-text formulas like x^2/2. Text extracted from PDFs often has garbled formulas; when the meaning is clear, write them back as proper LaTeX. If you need a literal dollar sign, write \\$.
- Each response sets \`mood\` for your mascot body language and a \`mascot_line\`: one short in-character remark (at most 15 words) that the learner sees in a speech bubble. Keep it playful, never repeating the main content.`;

/** Added to prompts when the learner attached images of their work. */
function imagesNote(images: ImageInput[] | undefined): string {
  if (!images?.length) return "";
  return `\n\nThe learner attached ${images.length} image${images.length > 1 ? "s" : ""} of their work (for example handwriting, a diagram or worked steps). Read ${images.length > 1 ? "them" : "it"} carefully and treat ${images.length > 1 ? "them" : "it"} as part of their answer. Transcribe any formulas you rely on into LaTeX. If something is illegible, say so instead of guessing.`;
}

const mood = { type: "string", enum: MOODS };
const strList = { type: "array", items: { type: "string" } };
const str = { type: "string" };

function obj(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties) };
}

// ---------------------------------------------------------------------------
// Concept extraction

export function extractConcepts(
  c: ClaudeOptions,
  title: string,
  body: string,
  known: string[],
): Promise<{ concepts: ExtractedConcept[] }> {
  const schema = obj({
    concepts: {
      type: "array",
      items: obj({
        name: { type: "string", description: "the specific idea in 3-8 words, not a heading" },
        summary: { type: "string", description: "1-2 sentences, faithful to the note" },
        prerequisites: strList,
        excerpt: { type: "string", description: "verbatim supporting quote from the note, <= 300 chars" },
        questions: { ...strList, description: "2-3 focused Feynman questions about the core of the idea" },
      }),
    },
  });
  const prompt = `Extract the key teachable concepts from this note so the learner can be taught and quizzed on them.

- Return between 1 and 12 concepts, ordered from foundational to advanced. Fewer for short notes.
- A concept is ONE specific, explainable idea, not a section heading or a topic area. Look under each heading for the core idea(s) it teaches: a mechanism, a cause and effect, a relationship, or why something is true or useful. A heading can yield several concepts, or none if it's just a list. Skip trivia and pure lists of names.
- \`name\`: the idea itself, specific enough to be recognisable (e.g. "Kinetic energy grows with the square of speed", not "Kinetic energy"; "TCP resends only the lost segment", not "Reliability").
- \`questions\`: 2-3 focused questions that make the learner explain the core of this idea in their own words, each from a different angle (why it's true, how it works, when you'd use it, what would happen if...). Each should be answerable in a few sentences, must not give the answer away, and must not just restate the heading ("Explain X" is not allowed). Example: "Why does doubling an object's speed quadruple its kinetic energy?"
- \`prerequisites\`: names of concepts that must be understood first. Reuse names from the known list (or from this note) when they match; otherwise use a short general name. Empty if none.
- \`excerpt\`: a verbatim quote from the note supporting the concept.

Known concept names elsewhere in the library: ${known.length ? known.join("; ") : "(none yet)"}

<note title="${title}">
${body}
</note>`;
  return ask(c, PERSONA, prompt, schema);
}

// ---------------------------------------------------------------------------
// Feynman evaluation

export interface FeynmanInput {
  concept: Concept;
  /** The question the learner was asked about this concept. */
  question: string;
  noteTitle: string;
  noteBody: string;
  attempt: number;
  explanation: string;
  previousGaps: Gap[];
  peeked: boolean;
  stuck: boolean;
  images?: ImageInput[];
  /** Clawd's last "your turn" prompt, which this attempt may be answering. */
  followUp?: string;
}

export function evaluateFeynman(c: ClaudeOptions, i: FeynmanInput): Promise<FeynmanEval> {
  const schema = obj({
    score: { type: "number", minimum: 0, maximum: 100 },
    passed: { type: "boolean" },
    got_right: strList,
    gaps: {
      type: "array",
      items: obj({ kind: { type: "string", enum: ["missing", "wrong", "jargon", "vague"] }, issue: str, fix: str }),
    },
    reteach: str,
    analogy: str,
    next_prompt: str,
    note_issues: strList,
    prerequisite_gap: str,
    mood,
    mascot_line: str,
  });
  const prev = i.previousGaps.length
    ? `\nGaps you flagged on the previous attempt (check whether they're fixed now):\n${i.previousGaps
        .map((g) => `- [${g.kind}] ${g.issue}`)
        .join("\n")}\n`
    : "";
  const task = i.stuck
    ? "The learner says they're stuck and can't explain this yet. Score 0, passed=false. Teach the concept from the ground up in `reteach` as simply as possible (aim for a 12-year-old), give a vivid `analogy`, and use `next_prompt` to invite them to try explaining it back in their own words."
    : `This is attempt #${i.attempt + 1}. Evaluate the learner's explanation the way Feynman would.
- Judge ONLY the concept named above. The note may cover other concepts too; those are taught separately, so never mark them as missing. Use the rest of the note only as background.
- \`got_right\`: specific things they explained correctly.
- \`gaps\`: each problem: \`missing\` (important idea absent), \`wrong\` (incorrect claim; describe the exact misconception), \`jargon\` (term used without being explained, a sign of hiding a gap), \`vague\` (hand-waving). \`fix\` says in one sentence what a correct version would say.
- \`score\` 0-100 for depth and accuracy. \`passed\` only if score >= 80 and there are no \`wrong\` gaps.
- \`reteach\`: if not passed, re-teach ONLY the gaps, simply, in Markdown. Do not dump the whole note. If passed, a 1-2 sentence 'one level deeper' nugget.
- \`analogy\`: one fresh analogy that makes the hardest gap click (empty if passed).
- \`next_prompt\`: if not passed, a focused instruction for the next attempt, such as which part to re-explain. If passed, one stretch question.
- \`note_issues\`: anything in the learner's notes that is wrong, contradictory or too thin to learn from. Usually empty.
- \`prerequisite_gap\`: if the errors show a missing prerequisite concept, its name; else empty.${
        i.peeked ? "\nNote: the learner peeked at their note excerpt before this attempt." : ""
      }`;
  const prompt = `Concept: **${i.concept.name}**
The learner was asked: "${i.question || `Explain ${i.concept.name}`}"${
    i.followUp?.trim() ? `\nAfter the last attempt you prompted them: "${i.followUp.trim()}". This attempt may answer that prompt.` : ""
  }
Judge their explanation as an answer to that question (the core of this concept), not as a summary of the whole note.
Summary (from indexing): ${i.concept.summary}
Prerequisites: ${i.concept.prerequisites.length ? i.concept.prerequisites.join(", ") : "none"}
${prev}
${task}

<note title="${i.noteTitle}">
${i.noteBody}
</note>

<learner_explanation>
${i.explanation.trim() || (i.images?.length ? "(see the attached image)" : "(nothing; learner is stuck)")}
</learner_explanation>${imagesNote(i.images)}`;
  return ask(c, PERSONA, prompt, schema, i.images);
}

// ---------------------------------------------------------------------------
// Quizzes

export interface QuizMaterial {
  concept: Concept;
  noteTitle: string;
  noteBody: string;
}

export interface QuizMisconception {
  id: number;
  concept_id: number | null;
  text: string;
}

export function makeQuiz(c: ClaudeOptions, items: QuizMaterial[], misconceptions: QuizMisconception[], n: number): Promise<QuizSet> {
  const schema = obj({
    questions: {
      type: "array",
      items: obj({
        concept_id: { type: "integer", enum: items.map((m) => m.concept.id), description: "ID of the concept being tested" },
        misconception_id: { type: ["integer", "null"], enum: [null, ...misconceptions.map((m) => m.id)], description: "ID of the existing misconception being tested, else null" },
        concept: { type: "string", description: "exact concept name from the list" },
        kind: { type: "string", enum: ["mcq", "short", "explain_why", "spot_error"] },
        question: str,
        options: strList,
        correct_option: { type: "integer", description: "0-based index for mcq, else -1" },
        answer: { type: "string", description: "model answer / key points" },
        explanation: { type: "string", description: "why the answer is right (shown after)" },
      }),
    },
    mood,
    mascot_line: str,
  });
  const material = items
    .map((m) => `### Concept ID ${m.concept.id}: ${m.concept.name}\nSummary: ${m.concept.summary}\nFrom note "${m.noteTitle}":\n${m.noteBody}\n`)
    .join("\n");
  const misc = misconceptions.length ? misconceptions.map((m) => `- Misconception ID ${m.id} (concept ID ${m.concept_id}): ${m.text}`).join("\n") : "none recorded";
  const prompt = `Write a ${n}-question quiz on the concepts below, based on the learner's notes.
- Mix the kinds: \`mcq\` (4 options; distractors must be plausible misconceptions, not jokes), \`short\` (one-sentence factual recall), \`explain_why\` (asks for reasoning), \`spot_error\` (present a subtly flawed statement and ask what's wrong with it).
- Test understanding, not memorized wording. Vary difficulty. Spread across the concepts.
- Set \`concept_id\` to the exact ID from the materials, even if two concepts share a name. Set \`misconception_id\` to the existing misconception's ID when testing it (it must belong to that concept), otherwise null.
- The learner has these unresolved misconceptions. Write at least one question that would expose each one if it's still there:
${misc}
- For non-mcq use options=[] and correct_option=-1.

${material}`;
  return ask(c, PERSONA, prompt, schema);
}

export function grade(
  c: ClaudeOptions,
  q: Question,
  userAnswer: string,
  confidence: string,
  context: string,
  images: ImageInput[] = [],
  target?: QuizMisconception,
): Promise<Grade> {
  const schema = obj({
    correct: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 100 },
    feedback: str,
    misconception: str,
    misconception_id: { type: ["integer", "null"], enum: [null, ...(target ? [target.id] : [])] },
    prerequisite_gap: str,
    lesson: str,
    analogy: str,
    check_question: str,
    check_answer: str,
    mood,
    mascot_line: str,
  });
  const options = isMcq(q) ? `Options:\n${q.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n` : "";
  const prompt = `Grade the learner's quiz answer. Be fair: accept correct answers phrased differently; partial credit allowed.
The learner rated their confidence as: ${confidence}.

- \`feedback\`: 1-3 sentences on what was right or wrong.
- If NOT fully correct: diagnose WHY. In \`misconception\`, state the specific wrong belief as a short standalone sentence (e.g. "Thinks TCP retransmits individual bytes"), or empty if it was just a slip or blank. In \`prerequisite_gap\`, name a missing prerequisite concept if that's the root cause. \`lesson\`: a short, clear Markdown mini-lesson that fixes exactly this misunderstanding, grounded in the notes. \`analogy\`: one analogy that makes it click. \`check_question\`: a NEW question (different from the original, not answerable by pattern-matching it) that checks the fix landed, and \`check_answer\` is its key.
- If correct: lesson/analogy/check_* empty, misconception empty. If they were unsure but right, reassure them.
- Set \`misconception_id\` to the existing ID below ONLY if your diagnosis is that same underlying wrong belief, even if you word it differently. For a different belief, a slip, or a correct answer, use null. The mini-lesson and check question must address the belief you actually diagnosed.
- If they were confident and wrong, gently point out that this is the most valuable kind of mistake to catch.

Existing misconception: ${target ? `ID ${target.id}: ${target.text}` : "none"}

Concept: ${q.concept}
Question (${q.kind}): ${q.question}
${options}Answer key: ${q.answer}
Key explanation: ${q.explanation}

<notes_context>
${context}
</notes_context>

<learner_answer>
${userAnswer.trim() || (images.length ? "(see the attached image)" : "(blank)")}
</learner_answer>${imagesNote(images)}`;
  return ask(c, PERSONA, prompt, schema, images);
}

export function check(
  c: ClaudeOptions,
  question: string,
  key: string,
  misconception: string,
  userAnswer: string,
  images: ImageInput[] = [],
): Promise<CheckResult> {
  const schema = obj({ understood: { type: "boolean" }, feedback: str, mood, mascot_line: str });
  const prompt = `After a mini-lesson, you asked the learner a check question to confirm a misconception is fixed.
Decide if their answer shows real understanding (\`understood\`). \`feedback\`: 1-3 sentences; if not understood, add one more simple nudge in a different style than before.

Misconception being fixed: ${misconception || "(general misunderstanding)"}
Check question: ${question}
Key: ${key}

<learner_answer>
${userAnswer.trim() || (images.length ? "(see the attached image)" : "(blank)")}
</learner_answer>${imagesNote(images)}`;
  return ask(c, PERSONA, prompt, schema, images);
}

// ---------------------------------------------------------------------------
// Free-form questions to the tutor

export function chat(
  c: ClaudeOptions,
  context: string,
  history: [boolean, string][],
  message: string,
  images: ImageInput[] = [],
): Promise<ChatReply> {
  const schema = obj({ reply: str, mood, mascot_line: str });
  const convo = history
    .slice(-12)
    .map(([fromUser, text]) => `${fromUser ? "Learner" : "Clawd"}: ${text}\n\n`)
    .join("");
  const prompt = `The learner is asking you something during a study session. Answer as their tutor in \`reply\` (Markdown). Keep it focused and short unless they ask for depth. If the question shows confusion, address the root cause and finish with a tiny question that checks they understood.

<session_context>
${context}
</session_context>

<conversation_so_far>
${convo}</conversation_so_far>

<learner_message>
${message || "(see the attached image)"}
</learner_message>${imagesNote(images)}`;
  return ask(c, PERSONA, prompt, schema, images);
}

// ---------------------------------------------------------------------------
// Teach: Socratic lessons on whatever the learner asks for

/** Buttons in the Teach composer send these instead of free text. */
export const TEACH_CONTROLS: Record<string, string> = {
  start: "(The learner just chose this topic. Open the lesson: find out briefly what they already know, with one question.)",
  hint: "(The learner pressed HINT: give one small hint toward the current question. Do not reveal the answer.)",
  show: "(The learner pressed SHOW ME: they are stuck. Now explain this step fully and clearly, then move on with a new question.)",
  next: "(The learner pressed I GET IT: they understand this step. Move to the next step of the plan, optionally with a quick check.)",
  wrap: "(The learner pressed WRAP UP: end the lesson now. Set stage to wrap_up and write the summary.)",
};

export function teach(
  c: ClaudeOptions,
  topic: string,
  notesContext: string,
  history: [boolean, string][],
  message: string,
  images: ImageInput[] = [],
): Promise<TeachReply> {
  const schema = obj({
    reply: str,
    stage: { type: "string", enum: ["intro", "teaching", "checking", "wrap_up"] },
    progress: { type: "integer", minimum: 0, maximum: 100 },
    step_title: str,
    summary: str,
    mood,
    mascot_line: str,
  });
  const convo = history
    .slice(-20)
    .map(([fromUser, text]) => `${fromUser ? "Learner" : "Clawd"}: ${text}\n\n`)
    .join("");
  const prompt = `You are giving the learner a one-to-one lesson on the topic they asked for. Teach it Socratically: guide them to work things out instead of spoon-feeding.

How to teach:
- Keep a plan of 3-6 small steps that build from what they already know to the full idea. Report \`progress\` (0-100) through that plan and a short \`step_title\` for the current step.
- Each turn, \`reply\` is SHORT (at most ~120 words): a small piece of explanation, a concrete example or a nudge, and then exactly ONE question or tiny task that makes the learner think (predict, reason, compute, explain back, or spot a pattern). End with that question.
- Do not give away answers you're asking for. If they're wrong or unsure, respond to their reasoning, then give a hint or a simpler sub-question. Only explain fully when they press SHOW ME, or after two failed tries at the same question.
- When they get something right, say specifically what was right and build on it.
- Use the learner's own notes below when they're relevant; quote them briefly. Anything beyond their notes is fine, but label it "Beyond your notes:".
- \`stage\`: intro (finding out what they know), teaching, checking (a final check that they can explain the whole idea), wrap_up (lesson over). At wrap_up, \`reply\` congratulates and recaps in 2-3 sentences, and \`summary\` is a concise Markdown study note of what they learned (key ideas, formulas in LaTeX, one worked example, and a short "test yourself" list). Otherwise \`summary\` is empty.
- Move to wrap_up yourself once they can explain the whole idea back.

Topic the learner asked for: ${topic}

<learner_notes>
${notesContext || "(none of the learner's notes cover this topic)"}
</learner_notes>

<lesson_so_far>
${convo || "(just starting)"}</lesson_so_far>

<learner_message>
${message || "(see the attached image)"}
</learner_message>${imagesNote(images)}`;
  return ask(c, PERSONA, prompt, schema, images);
}
