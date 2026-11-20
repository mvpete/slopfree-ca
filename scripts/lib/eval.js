// Shared eval steps: prepare articles (points + baseline), run a prompt, score it.
import { createWiki } from "./wiki.js";
import { createTasks, createFakeTasks } from "./tasks.js";
import { createOpenAI, createBudget, BudgetExceeded } from "./llm.js";
import { articleStats, score, checkGate } from "./gate.js";
import { pool } from "./util.js";

export function createContext(cfg) {
  const budget = createBudget(cfg.maxTokensPerRun);
  const tasks = cfg.dryRun
    ? createFakeTasks()
    : createTasks(cfg, createOpenAI({ apiKey: process.env.OPENAI_API_KEY, budget }));
  const wiki = createWiki(cfg.wikipedia);
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  return { cfg, budget, tasks, wiki, log };
}

// Pick n articles, extract major points, summarize with the plain baseline, judge it.
export async function prepareArticles(ctx, n, exclude, { baseline = true } = {}) {
  const { cfg, wiki, tasks, log } = ctx;
  const candidates = await wiki.pickArticles(Math.ceil(n * 1.25), { minWords: cfg.minWords, maxWords: cfg.maxWords, exclude });
  const ready = [];
  let cursor = 0;
  while (ready.length < n && cursor < candidates.length) {
    const batch = candidates.slice(cursor, cursor + (n - ready.length));
    cursor += batch.length;
    const done = await pool(batch, cfg.concurrency, async (a) => {
      try {
        const { points, key } = await tasks.extractPoints(a);
        if (!baseline) return { ...a, points, key }; // quiz-only: no baseline, no grading
        const s = await tasks.summarize(a, null);
        const j = await tasks.judge(a, points, s.text);
        return { ...a, points, key, baseline: { summary: s.text, words: s.words, dashes: s.dashes, ...j } };
      } catch (e) {
        if (e instanceof BudgetExceeded) throw e;
        log(`skipped ${a.slug}: ${e.message}`);
        return null;
      }
    });
    ready.push(...done.filter(Boolean));
  }
  if (ready.length < n) throw new Error(`Prepared only ${ready.length} of ${n} articles`);
  log(`prepared ${ready.length} articles`);
  return ready;
}

// Summarize every article with the postfix and judge it.
export async function runPrompt(ctx, postfix, articles, { judge = true } = {}) {
  const { cfg, tasks } = ctx;
  return pool(articles, cfg.concurrency, async (a) => {
    const s = await tasks.summarize(a, postfix);
    if (!judge) return { slug: a.slug, summary: s.text, words: s.words, dashes: s.dashes };
    const j = await tasks.judge(a, a.points, s.text);
    return { slug: a.slug, summary: s.text, words: s.words, dashes: s.dashes, ...j };
  });
}

// Quiz questions, written from the summaries readers will see (one per article, answerable from each).
// Articles where no such question can be written are left out of the quiz.
export async function addQuestions(ctx, articles, runsList) {
  const { cfg, tasks, log } = ctx;
  const bySlug = runsList.map((runs) => Object.fromEntries(runs.map((r) => [r.slug, r])));
  await pool(articles, cfg.concurrency, async (a) => {
    const summaries = bySlug.map((m) => m[a.slug]?.summary).filter(Boolean);
    if (summaries.length !== runsList.length) return;
    try {
      a.question = await tasks.writeQuestion(a, summaries);
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      log(`no question for ${a.slug}: ${e.message}`);
    }
  });
  return articles.filter((a) => a.question);
}

export function scoreRuns(cfg, articles, runs) {
  // Key points are worth 1, detail points cfg.gate.detailWeight (0 by default).
  const weightsOf = (a) => (a.key ? a.key.map((k) => (k ? 1 : cfg.gate.detailWeight ?? 0)) : null);
  const stats = articles.map((a, i) => articleStats(a.slug, a.baseline, runs[i], a.source.words, weightsOf(a)));
  const sc = score(stats);
  return { stats, score: sc, gate: checkGate(sc, cfg.gate) };
}

export { BudgetExceeded };
