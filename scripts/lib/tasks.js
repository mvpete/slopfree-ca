// The model tasks: answer key, summarize, judge, draft, quiz question. Plus a fake set for DRY_RUN.
// Every task takes its model and effort from the caller (cfg.writers / cfg.drafter / cfg.questions),
// and tags its calls with a role so spend and output sizes are tracked per job.
import { wordCount } from "./util.js";

// Em dashes, and spaced en dashes used as dashes, counted mechanically in every summary.
export const countDashes = (text) => (text.match(/—|\s–\s/g) || []).length;

// The answer key: only the points that matter, capped, most important first.
const POINTS_SYSTEM = `You build answer keys for summary evaluation.
List the key points of the article: what a reader needs to understand what the subject is, why it matters, and what happened. Losing one would leave a reader misinformed or missing the point.
Leave out supporting specifics a reader can do without: lists of examples, minor figures, secondary names, asides.
Each point is one atomic, checkable claim in plain words. Split compound claims. No repeats.
Cover the whole article, not just the opening. Most important first. At most {MAX} points; a short article may need far fewer.`;

const POINTS_SCHEMA = {
  type: "object",
  properties: { points: { type: "array", items: { type: "string" } } },
  required: ["points"],
  additionalProperties: false,
};

const QUESTION_SYSTEM = `You write one EASY reading check. A reader reads exactly one of the summaries below, once, at normal speed, then answers. It only confirms they read and understood the summary; it is not a test of memory or detail.
Ask about the summary's main point: what the subject is or did, or the single most important thing the summary says about it. Take it from the first sentence or two. Every summary must state the answer.
Anyone who read the summary once should get it right without thinking. Do not ask about numbers, dates, secondary names, lists or anything from later in the summary.
The topic title is shown to the reader, so the answer must not be the title itself or guessable from the title alone.
Keep the question under 15 words. Give 4 options of a few words each. One is correct. The other three are plausible fakes: the kind of confident, believable answer an AI would invent. Same kind of answer as the correct one, similar length and wording, the sort of thing that could be true of this subject, so a reader who skimmed or guessed from the title could pick one. Each fake must be wrong according to the summary.
For each summary, quote the exact words that contain the answer (copy them character for character, 3 to 25 words).

Return JSON: {"text": "...", "options": ["...","...","...","..."], "answer": <0-3>, "quotes": ["<quote from summary 1>", "<quote from summary 2>", ...]}`;

const norm = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

// The judge reads the article itself, so a claim is only "unsupported" if the article doesn't back it,
// not merely because it's a detail missing from the key-point list.
const JUDGE_SYSTEM = `You grade a summary of an article. You get the article, a numbered list of its key points, and the summary. Be strict and literal.
1. Key points: a point is covered only if the summary states it, or states something that clearly implies it. Paraphrase is fine. Partly stated means not covered.
2. Unsupported claims: list every claim in the summary that the article does not support, or that contradicts it.
3. AI-style writing: list every literary or rhetorical device used instead of plain statement, such as "not just X but Y", rhetorical questions, lists of three for rhythm, metaphors, dramatic or promotional language, stock phrases ("worth noting", "plays a crucial role", "rich history"), and restating what was already said. Quote each one briefly.
You are not told who wrote the summary. Judge only what is written.`;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    covered: { type: "array", items: { type: "integer" }, description: "1-based numbers of the key points the summary covers" },
    unsupported: { type: "array", items: { type: "string" } },
    style: { type: "array", items: { type: "string" } },
  },
  required: ["covered", "unsupported", "style"],
  additionalProperties: false,
};

// The drafter never hears about Wikipedia or answer keys: real requests have neither, and a prompt
// written for the test (2026-11-27: "use only the material the source marks as key") helps nobody.
// It aims at the fixed bar, consistently, not at beating anyone.
const DRAFT_SYSTEM = `You write postfix prompts. A postfix is pasted at the end of any request so the AI gives the whole answer in fewer words: every important fact kept, nothing made up, no filler.
To test one, it is pasted after "Summarize the following article:" plus an article. A candidate qualifies only if, across every test article, the output:
{CRITERIA}
Aim to clear every requirement with room to spare on every article, every time. One lucky pass is worth less than a prompt that reliably clears the bar.
Beyond the bar, more important points, fewer words and plainer writing are all better.
It is published for everyday use, so write general guidance for any request. Do not mention articles, summaries, sources, Wikipedia, key points or this test.
Study the failures below: which important points were dropped, which claims were made up, which phrases were flagged. Fix those causes.
Write {N} candidates that differ in a real way from each other and from earlier attempts. Make at least one a small, targeted edit of the current golden prompt. Each must tell the writer plainly: no em dashes, no literary techniques, plain statements. Write them the same way, under {MAX} characters each.

Return JSON: {"candidates": [{"prompt": "...", "idea": "<one sentence: what's different and which failures it fixes>"}]}`;

// The requirements in words, exactly as they're checked (scripts/lib/qualify.js).
export function describeCriteria(q) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = [];
  if (q.keyPointCoverage) lines.push(`- keeps at least ${pct(q.keyPointCoverage.min)} of the article's important points`);
  if (q.compression) lines.push(`- is at least ${pct(q.compression.min)} shorter than the same AI's answer without the postfix`);
  if (q.unsupported) lines.push(q.unsupported.max === 0 ? "- makes up nothing: every claim is backed by the source" : `- makes at most ${q.unsupported.max} unsupported claims in total`);
  if (q.emDashes) lines.push(q.emDashes.max === 0 ? "- contains no em dashes at all" : `- contains at most ${q.emDashes.max} em dashes`);
  if (q.style) {
    const what = `literary or rhetorical devices ("not just X but Y", rhetorical questions, lists of three for rhythm, metaphors, dramatic or promotional language, stock phrases)`;
    lines.push(q.style.maxOverPlain !== undefined && q.style.maxOverPlain !== null
      ? `- uses no more ${what} than the same AI's answer without the postfix${q.style.maxOverPlain ? `, plus ${q.style.maxOverPlain}` : ""}`
      : `- uses at most ${q.style.max} ${what}`);
  }
  return lines.join("\n");
}

// Every prompt text that shapes a result, recorded in each report.
export const PROMPTS = { points: POINTS_SYSTEM, judge: JUDGE_SYSTEM, draft: DRAFT_SYSTEM, question: QUESTION_SYSTEM };

export function createTasks(cfg, llm) {
  const { wrapper } = cfg;

  // spec: { model, effort } from cfg.writers[i].keyPoints
  async function extractPoints(article, spec) {
    const max = cfg.articles.maxKeyPoints;
    const r = await llm.chat({
      model: spec.model,
      effort: spec.effort,
      role: "keyPoints",
      system: POINTS_SYSTEM.replace("{MAX}", String(max)),
      user: `Title: ${article.source.title}\n\n${article.text}`,
      schema: POINTS_SCHEMA,
    });
    const points = (r.points || [])
      .map((p) => (typeof p === "string" ? p : p?.text))
      .filter((p) => typeof p === "string" && p.trim())
      .map((p) => p.trim())
      .slice(0, max);
    if (points.length < 3) throw new Error(`only ${points.length} key points`);
    return { points, key: points.map(() => true) };
  }

  // One question answerable from every summary. The quotes are checked against the summaries, so a
  // question about a dropped fact can't get through.
  async function writeQuestion(article, summaries) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await llm.chat({
        model: cfg.questions.model,
        effort: cfg.questions.effort,
        role: "question",
        system: QUESTION_SYSTEM,
        user: `TOPIC: ${article.source.title}\n\n${summaries.map((s, i) => `SUMMARY ${i + 1}:\n${s}`).join("\n\n")}`,
        json: true,
      });
      const ok =
        typeof r.text === "string" &&
        Array.isArray(r.options) && r.options.length === 4 && r.options.every((o) => typeof o === "string") &&
        Number.isInteger(r.answer) && r.answer >= 0 && r.answer <= 3 &&
        Array.isArray(r.quotes) && r.quotes.length === summaries.length &&
        r.quotes.every((q, i) => typeof q === "string" && q.trim().length > 5 && norm(summaries[i]).includes(norm(q)));
      if (ok) return { text: r.text, options: r.options, answer: r.answer, quotes: r.quotes };
    }
    throw new Error("couldn't write a question answerable from every summary");
  }

  // writer: { model, effort } from cfg.writers[i]. Production settings, so results transfer.
  async function summarize(article, postfix, writer) {
    const user = `${wrapper}\n\n${article.text}` + (postfix ? `\n\n${postfix}` : "");
    const text = (await llm.chat({ model: writer.model, effort: writer.effort, role: "summary", user })).trim();
    return { text, words: wordCount(text), dashes: countDashes(text) };
  }

  // spec: { model, effort, role } from cfg.writers[i].judge or .screenJudge. Everything compared in one
  // score must come from the same judge.
  async function judge(article, points, summary, spec) {
    const r = await llm.chat({
      model: spec.model,
      effort: spec.effort,
      role: spec.role || "judge",
      system: JUDGE_SYSTEM,
      // Same article and key points for every summary of it, so this part is cached.
      shared: `ARTICLE: ${article.source.title}\n${article.text}\n\nKEY POINTS:\n${points.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
      user: `SUMMARY:\n${summary}`,
      schema: JUDGE_SCHEMA,
    });
    const covered = new Set((r.covered || []).map(Number).filter((n) => n >= 1 && n <= points.length));
    const unsupported = (r.unsupported || []).filter((c) => typeof c === "string");
    const style = (r.style || []).filter((c) => typeof c === "string");
    return {
      covered: points.map((_, i) => covered.has(i + 1)),
      unsupported: unsupported.length,
      unsupportedClaims: unsupported,
      style: style.length,
      styleIssues: style,
    };
  }

  // One call writes n candidates. feedback: plain text built from real failures (see weekly-topics.js).
  async function draft({ golden, n, criteria, feedback }) {
    const system = DRAFT_SYSTEM.replace("{CRITERIA}", describeCriteria(criteria)).replace("{N}", String(n)).replace("{MAX}", String(cfg.promptMaxChars));
    const r = await llm.chat({
      model: cfg.drafter.model,
      effort: cfg.drafter.effort,
      role: "drafter",
      system,
      user: `CURRENT GOLDEN PROMPT:\n${golden}\n\n${feedback || "NO FAILURES RECORDED YET."}`,
      json: true,
    });
    const list = (r.candidates || []).filter((c) => typeof c?.prompt === "string" && c.prompt.trim());
    if (!list.length) throw new Error("drafter returned no prompts");
    return list.slice(0, n).map((c) => ({ prompt: c.prompt.trim(), idea: c.idea || "" }));
  }

  return { extractPoints, summarize, judge, writeQuestion, draft, moderate: llm.moderate };
}

// Deterministic stand-ins so the whole loop can be exercised without an API key.
export function createFakeTasks(cfg) {
  const sentences = (t) => t.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/).filter((s) => s.length > 40);
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const FILLER = "In this context, it is also worth noting here that ";
  const max = cfg?.articles?.maxKeyPoints ?? 30;
  let drafted = 0;

  return {
    async extractPoints(article) {
      const points = sentences(article.text).slice(0, max); // fake: the first sentences are the key points
      if (points.length < 5) throw new Error("too few sentences");
      return { points, key: points.map(() => true) };
    },
    async writeQuestion(article, summaries) {
      const first = summaries[0].split(/(?<=[.!?])\s+/).find((s) => summaries.every((x) => x.includes(s.slice(0, 40)))) || summaries[0].slice(0, 60);
      return { text: `Which is true of ${article.source.title}?`, options: [first.slice(0, 90), "Option B", "Option C", "Option D"], answer: 0, quotes: summaries.map(() => first.slice(0, 40)) };
    },
    // Fake writer: the plain summary pads every sentence with filler. A postfix usually cuts it;
    // some postfixes drop sentences or keep the filler, so candidates can fail.
    async summarize(article, postfix) {
      const all = sentences(article.text).slice(0, max);
      if (!postfix) {
        const text = all.map((s) => FILLER + s).join(" ");
        return { text, words: wordCount(text), dashes: countDashes(text) };
      }
      const h = hash(postfix);
      let keep = all;
      if (h % 3 === 0) keep = keep.filter((_, i) => i % 4 !== 0); // drops a quarter of the points
      const text = keep.map((s) => (h % 5 === 0 ? FILLER + s : s)).join(" ").replace(/\s*—\s*|\s–\s/g, ", ");
      return { text, words: wordCount(text), dashes: countDashes(text) };
    },
    async judge(article, points, summary) {
      const style = summary.split(FILLER).length - 1 > 0 ? 1 : 0; // fake: filler counts as one stock phrase
      return { covered: points.map((p) => summary.includes(p)), unsupported: 0, unsupportedClaims: [], style, styleIssues: style ? ["worth noting"] : [] };
    },
    async draft({ golden, n }) {
      return Array.from({ length: n }, () => ({ prompt: `${golden}\n- Variant ${++drafted}: be briefer.`, idea: "fake" }));
    },
    async moderate() {
      return false;
    },
  };
}
