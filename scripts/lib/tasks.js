// The four model tasks: extract points, summarize, judge, draft. Plus a fake set for DRY_RUN.
import { wordCount } from "./util.js";

// Em dashes, and spaced en dashes used as dashes, counted mechanically in every summary.
export const countDashes = (text) => (text.match(/—|\s–\s/g) || []).length;

const POINTS_SYSTEM = `You build answer keys for summary evaluation.
List every point the article makes. Go through it section by section and do not stop early or cap the count: a short article may have a dozen points, a long one hundreds.
Each point is one atomic, checkable claim in plain words: a fact, cause, effect, date, number, name, or relationship.
Split compound sentences into separate points. Merge exact repeats. Leave out only navigation text, image captions and citation markers.

Label each point "key" or "detail".
- key: a reader needs it to understand what the subject is, why it matters, and what happened. Losing it would leave a reader misinformed or missing the point.
- detail: supporting specifics a reader can do without: lists of examples, minor figures, secondary names, asides.
Judge each point on its own merits; there is no quota.

Also write one multiple-choice question that tests one key point. It must need understanding, not keyword spotting.
Give 4 options; exactly one is correct, and the others are plausible but clearly wrong according to the article.

Return JSON: {"points": [{"text": "...", "key": true}, ...], "question": {"point": <1-based point number>, "text": "...", "options": ["...","...","...","..."], "answer": <0-3>}}`;

const JUDGE_SYSTEM = `You grade a summary against a numbered list of every point its source article makes. Be strict and literal.
A point is covered only if the summary states it, or states something that clearly implies it. Paraphrase is fine. Partly stated means not covered.
List every claim in the summary that no point supports, or that contradicts a point.
List every piece of AI-style writing in the summary: literary or rhetorical devices instead of plain statement, such as "not just X but Y", rhetorical questions, lists of three for rhythm, metaphors, dramatic or promotional language, stock phrases ("worth noting", "plays a crucial role", "rich history"), and restating what was already said. Quote each one briefly.
You are not told who wrote the summary. Judge only what is written.

Return JSON: {"covered": [<1-based numbers of covered points>], "unsupported": ["<claim>", ...], "style": ["<quoted AI-style phrase>", ...]}`;

const DRAFT_SYSTEM = `You improve a postfix prompt. It is pasted after this task: "Summarize the following article:" followed by the article.
Every point in the article is labelled key or detail. Only key points count. Your targets, measured against the same task with no postfix (the plain summary):
- Accuracy: keep at least {COVERAGE}% as many key points as the plain summary, and at least {FLOOR}% as many on every single article. They don't have to be the same points the plain summary chose.
- Efficiency: at least {DENSITY}x as many key points per word as the plain summary. That's the same key points in {EFFICIENCY}% fewer words. Dropping detail is free; padding with detail only costs words.
- Add no more unsupported claims than the plain summary.
- No AI-style writing. The summaries must contain no em dashes at all, and no more literary or rhetorical devices than the plain summary ("not just X but Y", rhetorical questions, lists of three for rhythm, metaphors, dramatic or promotional language, stock phrases). Your prompt must tell the writer this explicitly: no em dashes, no literary techniques, plain statements only.
A prompt that misses any target is rejected, so hit all of them.
The postfix is also published for everyday use, so it must read as general guidance for clear, information-dense writing, not instructions specific to Wikipedia or to this test.
Write the prompt itself the same way: plain, direct language, no em dashes, no literary techniques. Keep it under {MAX} characters.
Learn from the earlier attempts listed and do something meaningfully different from the ones that failed.

Return JSON: {"prompt": "...", "idea": "<one sentence on what you changed and why>"}`;

export function createTasks(cfg, llm) {
  const { writerModel, judgeModel, wrapper } = cfg;

  async function extractPoints(article) {
    const r = await llm.chat({
      model: judgeModel,
      system: POINTS_SYSTEM,
      user: `Title: ${article.source.title}\n\n${article.text}`,
      json: true,
    });
    const raw = (r.points || [])
      .map((p) => (typeof p === "string" ? { text: p, key: true } : p))
      .filter((p) => p && typeof p.text === "string" && p.text.trim());
    const points = raw.map((p) => p.text.trim());
    const key = raw.map((p) => p.key === true);
    const q = r.question || {};
    if (points.length < 5) throw new Error(`only ${points.length} points`);
    if (!key.some(Boolean)) throw new Error("no key points");
    if (!Array.isArray(q.options) || q.options.length !== 4 || !(q.answer >= 0 && q.answer <= 3)) throw new Error("bad question");
    return { points, key, question: { point: q.point, text: q.text, options: q.options, answer: q.answer } };
  }

  async function summarize(article, postfix) {
    const user = `${wrapper}\n\n${article.text}` + (postfix ? `\n\n${postfix}` : "");
    const text = (await llm.chat({ model: writerModel, user })).trim();
    return { text, words: wordCount(text), dashes: countDashes(text) };
  }

  // One grading pass against the point list. The point list holds every claim in the article, so the judge
  // never re-reads the article: that was about three quarters of the cost. Baseline and candidates are
  // graded the same way, so the comparison stays fair.
  async function judge(article, points, summary) {
    const r = await llm.chat({
      model: judgeModel,
      system: JUDGE_SYSTEM,
      user: `POINTS (from "${article.source.title}"):\n${points.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\nSUMMARY:\n${summary}`,
      json: true,
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

  // The drafter (gpt-6.2-sol by default) writes candidate prompts aimed at the gate's own thresholds.
  async function draft(golden, history, goldenResult) {
    const recent = history.slice(-12).map((h) => `Attempt ${h.n} (failed at ${h.stage}: ${h.reason})\n${h.prompt}`).join("\n\n---\n\n");
    const g = cfg.gate;
    const system = DRAFT_SYSTEM.replace("{MAX}", String(cfg.promptMaxChars))
      .replace("{COVERAGE}", String(Math.round(g.coverage * 100)))
      .replace("{FLOOR}", String(Math.round(g.floor * 100)))
      .replace("{DENSITY}", (1 / (1 - g.efficiency)).toFixed(2))
      .replace("{EFFICIENCY}", String(Math.round(g.efficiency * 100)));
    const r = await llm.chat({
      model: cfg.drafterModel || judgeModel,
      system,
      user: `CURRENT GOLDEN PROMPT:\n${golden}\n\nHOW THE GOLDEN PROMPT DID THIS WEEK:\n${goldenResult || "(not measured)"}\n\nEARLIER ATTEMPTS THIS WEEK:\n${recent || "(none yet)"}`,
      json: true,
    });
    if (typeof r.prompt !== "string" || !r.prompt.trim()) throw new Error("drafter returned no prompt");
    return { prompt: r.prompt.trim(), idea: r.idea || "" };
  }

  return { extractPoints, summarize, judge, draft, moderate: llm.moderate };
}

// Deterministic stand-ins so the whole loop can be exercised without an API key.
export function createFakeTasks() {
  const sentences = (t) => t.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/).filter((s) => s.length > 40);
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

  return {
    async extractPoints(article) {
      const points = sentences(article.text); // fake: every sentence is a point
      if (points.length < 5) throw new Error("too few sentences");
      const key = points.map((_, i) => i % 3 === 0); // fake: every third point is key
      return { points, key, question: { point: 1, text: `Which is true of ${article.source.title}?`, options: [points[0].slice(0, 90), "Option B", "Option C", "Option D"], answer: 0 } };
    },
    // Fake writer: the baseline pads every sentence with filler. A postfix usually cuts the filler
    // (shorter, same points); some postfixes also drop a point or keep the filler, so attempts can fail.
    async summarize(article, postfix) {
      const all = sentences(article.text).slice(0, 30);
      const FILLER = "In this context, it is also worth noting here that ";
      if (!postfix) {
        const text = all.map((s) => FILLER + s).join(" ");
        return { text, words: wordCount(text), dashes: countDashes(text) };
      }
      const h = hash(postfix);
      let keep = all;
      if (h % 3 === 0) keep = keep.filter((_, i) => i !== 0); // drops a key point
      const text = keep.map((s) => (h % 5 === 0 ? FILLER + s : s)).join(" ").replace(/\s*—\s*|\s–\s/g, ", "); // h % 5 === 0 keeps the filler; a postfix removes dashes
      return { text, words: wordCount(text), dashes: countDashes(text) };
    },
    async judge(article, points, summary) {
      return { covered: points.map((p) => summary.includes(p)), unsupported: 0, unsupportedClaims: [], style: 0, styleIssues: [] };
    },
    async draft(golden, history) {
      return { prompt: `${golden}\n- Variant ${history.length + 1}: be briefer.`, idea: "fake" };
    },
    async moderate() {
      return false;
    },
  };
}
