// The four model tasks: extract points, summarize, judge, draft. Plus a fake set for DRY_RUN.
import { wordCount } from "./util.js";

const POINTS_SYSTEM = `You build answer keys for summary evaluation.
List every point the article makes. Go through it section by section and do not stop early or cap the count: a short article may have a dozen points, a long one hundreds.
Each point is one atomic, checkable claim in plain words: a fact, cause, effect, date, number, name, or relationship.
Split compound sentences into separate points. Merge exact repeats. Leave out only navigation text, image captions and citation markers.

Also write one multiple-choice question that tests one of the points. It must need understanding, not keyword spotting.
Give 4 options; exactly one is correct, and the others are plausible but clearly wrong according to the article.

Return JSON: {"points": ["..."], "question": {"point": <1-based point number>, "text": "...", "options": ["...","...","...","..."], "answer": <0-3>}}`;

const JUDGE_SYSTEM = `You grade a summary against an article and a numbered list of major points. Be strict and literal.
A point is covered only if the summary states it, or states something that clearly implies it. Paraphrase is fine. Partly stated means not covered.
Also list every claim in the summary that the article does not support or that contradicts the article.
You are not told who wrote the summary. Judge only what is written.

Return JSON: {"covered": [<1-based numbers of covered points>], "unsupported": ["<claim>", ...]}`;

const DRAFT_SYSTEM = `You improve a postfix prompt. It is pasted after this task: "Summarize the following article:" followed by the article.
Goal, measured against the same task with no postfix:
- keep at least 98% of the major points the plain summary keeps,
- add no unsupported claims,
- use at least 20% fewer words.
The postfix is also published for everyday use, so it must read as general guidance for clear, information-dense writing, not instructions specific to Wikipedia or to this test.
Write plain, direct language. Keep it under {MAX} characters.
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
    const points = (r.points || []).filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim());
    const q = r.question || {};
    if (points.length < 5) throw new Error(`only ${points.length} points`);
    if (!Array.isArray(q.options) || q.options.length !== 4 || !(q.answer >= 0 && q.answer <= 3)) throw new Error("bad question");
    return { points, question: { point: q.point, text: q.text, options: q.options, answer: q.answer } };
  }

  async function summarize(article, postfix) {
    const user = `${wrapper}\n\n${article.text}` + (postfix ? `\n\n${postfix}` : "");
    const text = (await llm.chat({ model: writerModel, user })).trim();
    return { text, words: wordCount(text) };
  }

  async function judgeOnce(article, points, summary) {
    const r = await llm.chat({
      model: judgeModel,
      system: JUDGE_SYSTEM,
      user: `ARTICLE:\n${article.text}\n\nPOINTS:\n${points.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\nSUMMARY:\n${summary}`,
      json: true,
    });
    return {
      covered: new Set((r.covered || []).map(Number).filter((n) => n >= 1 && n <= points.length)),
      unsupported: (r.unsupported || []).filter((c) => typeof c === "string"),
    };
  }

  // Judged twice; a point counts only if both passes agree it's covered. Unsupported takes the worse pass.
  async function judge(article, points, summary) {
    const [a, b] = await Promise.all([judgeOnce(article, points, summary), judgeOnce(article, points, summary)]);
    const worse = a.unsupported.length >= b.unsupported.length ? a : b;
    return {
      covered: points.map((_, i) => a.covered.has(i + 1) && b.covered.has(i + 1)),
      unsupported: worse.unsupported.length,
      unsupportedClaims: worse.unsupported,
    };
  }

  async function draft(golden, history) {
    const recent = history.slice(-12).map((h) => `Attempt ${h.n} (failed at ${h.stage}: ${h.reason})\n${h.prompt}`).join("\n\n---\n\n");
    const r = await llm.chat({
      model: judgeModel,
      system: DRAFT_SYSTEM.replace("{MAX}", String(cfg.promptMaxChars)),
      user: `CURRENT GOLDEN PROMPT:\n${golden}\n\nEARLIER ATTEMPTS THIS WEEK:\n${recent || "(none yet)"}`,
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
      return { points, question: { point: 1, text: `Which is true of ${article.source.title}?`, options: [points[0].slice(0, 90), "Option B", "Option C", "Option D"], answer: 0 } };
    },
    // Fake writer: the baseline pads every sentence with filler. A postfix usually cuts the filler
    // (shorter, same points); some postfixes also drop a point or keep the filler, so attempts can fail.
    async summarize(article, postfix) {
      const all = sentences(article.text).slice(0, 30);
      const FILLER = "In this context, it is also worth noting here that ";
      if (!postfix) {
        const text = all.map((s) => FILLER + s).join(" ");
        return { text, words: wordCount(text) };
      }
      const h = hash(postfix);
      let keep = all;
      if (h % 3 === 0) keep = keep.filter((_, i) => i !== 1); // drops a point
      const text = keep.map((s) => (h % 5 === 0 ? FILLER + s : s)).join(" "); // h % 5 === 0 keeps the filler
      return { text, words: wordCount(text) };
    },
    async judge(article, points, summary) {
      return { covered: points.map((p) => summary.includes(p)), unsupported: 0, unsupportedClaims: [] };
    },
    async draft(golden, history) {
      return { prompt: `${golden}\n- Variant ${history.length + 1}: be briefer.`, idea: "fake" };
    },
    async moderate() {
      return false;
    },
  };
}
