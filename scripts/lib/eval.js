// Shared eval steps: prepare articles (answer key + plain summary), run a prompt, re-grade, add quiz
// questions. One writer per run (cfg.writer), graded by the other model family.
import { createWiki } from "./wiki.js";
import { createTasks, createFakeTasks } from "./tasks.js";
import { createLLM, createBudget, BudgetExceeded } from "./llm.js";
import { pool } from "./util.js";
import { keyPointsFor } from "./config.js";

export function createContext(cfg) {
  const budget = createBudget(cfg.budget.maxUsd, cfg.budget.prices);
  const tasks = cfg.dryRun
    ? createFakeTasks(cfg)
    : createTasks(cfg, createLLM({ budget, openaiKey: process.env.OPENAI_API_KEY, anthropicKey: process.env.ANTHROPIC_API_KEY }));
  const wiki = createWiki(cfg.wikipedia);
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  return { cfg, budget, tasks, wiki, log };
}

// Pick n articles and prepare them: an answer key (from the judge's family) and the writer's plain
// summary, graded by its judge. (Works for a list of writers; a weekly run has one.)
//   default                       answer key + plain summaries, graded
//   { gradePlain: false }         answer key + plain summaries, words only
//   { baseline: false }           nothing extra: quiz-only articles (older scripts use this name)
//   { titles: [...] }             these articles first (reusing an earlier run's), then random ones
// article.plain = { <writer name>: plain summary }; article.baseline = the first writer's, for older code.
export async function prepareArticles(ctx, n, exclude, { writers = ctx.cfg.writers, baseline = true, keyPoints = baseline, gradePlain = baseline, titles = [] } = {}) {
  const { cfg, wiki, tasks, log } = ctx;
  const a0 = cfg.articles;
  const wanted = [];
  for (const t of titles) {
    if (wanted.length >= n) break;
    const art = await wiki.fetchArticle(t, { maxWords: a0.maxWords }).catch(() => null);
    if (art && !exclude.has(art.slug)) { exclude.add(art.slug); wanted.push(art); }
    else log(`couldn't reuse "${t}"`);
  }
  const random = wanted.length < n ? await wiki.pickArticles(Math.ceil((n - wanted.length) * 1.25), { minWords: a0.minWords, maxWords: a0.maxWords, exclude }) : [];
  const candidates = [...wanted, ...random];
  const ready = [];
  let cursor = 0;
  while (ready.length < n && cursor < candidates.length) {
    const batch = candidates.slice(cursor, cursor + (n - ready.length));
    const offset = cursor;
    cursor += batch.length;
    const done = await pool(batch, cfg.concurrency, async (a, j) => {
      try {
        if (!keyPoints) return { ...a, points: [], key: [] };
        const kp = keyPointsFor(cfg);
        const { points, key } = await tasks.extractPoints(a, kp);
        if (!baseline) return { ...a, points, key, keyPointsModel: kp.model };
        const plain = {};
        for (const w of writers) {
          const s = await tasks.summarize(a, null, w);
          plain[w.name] = { summary: s.text, words: s.words, dashes: s.dashes, writer: w.name };
          if (gradePlain) Object.assign(plain[w.name], await tasks.judge(a, points, s.text, w.judge));
        }
        return { ...a, points, key, keyPointsModel: kp.model, plain, baseline: plain[writers[0].name] };
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

// Write every article with the postfix, and grade it with judge ({ model, effort, role }), or not
// at all with judge: false.
export async function runPrompt(ctx, postfix, articles, { writer = ctx.cfg.writer, judge = writer.judge } = {}) {
  const { cfg, tasks } = ctx;
  return pool(articles, cfg.concurrency, async (a) => {
    const s = await tasks.summarize(a, postfix, writer);
    const run = { slug: a.slug, writer: writer.name, summary: s.text, words: s.words, dashes: s.dashes };
    if (!judge) return run;
    return { ...run, ...(await tasks.judge(a, a.points, s.text, judge)) };
  });
}

// Grade summaries that already exist with another judge (no new writing). runs line up with articles.
export async function rejudge(ctx, articles, runs, judge) {
  const { cfg, tasks } = ctx;
  return pool(articles, cfg.concurrency, async (a, i) => {
    const r = runs[i];
    return { slug: r.slug, writer: r.writer, summary: r.summary, words: r.words, dashes: r.dashes, ...(await tasks.judge(a, a.points, r.summary, judge)) };
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

export { BudgetExceeded };
