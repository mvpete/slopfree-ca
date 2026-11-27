// Add quiz-only articles to the current trial: golden and challenger summaries, each checked before
// publication, and a question every summary answers.
//
//   node scripts/add-articles.js [count]     (default 20)
//
// Publication checks are mandatory (cfg.publication): every summary readers will see is graded by the
// other model family for unsupported claims, and run through moderation. An article with any summary
// that fails is left out. Results go to evals/<date>-articles.json; no other report is touched.
import fs from "node:fs";
import { loadConfig } from "./lib/config.js";
import { createContext, prepareArticles, runPrompt, addQuestions, BudgetExceeded } from "./lib/eval.js";
import { readJSON, readGolden, readText, existingSlugs, writeJSON } from "./lib/store.js";
import { spendLine } from "./lib/llm.js";
import { promptName, pool, today } from "./lib/util.js";

const cfg = loadConfig();
const model = cfg.model;
// Same writer as the running trial, so every quiz summary in it comes from one model.
const trial = readJSON(`prompts/${model}/trial.json`, null);
if (trial?.writer) {
  const w = cfg.writerPool.find((x) => x.name === trial.writer);
  if (!w) throw new Error(`trial.json writer "${trial.writer}" is not in the config`);
  cfg.writer = w;
  cfg.writers = [w];
}
const ctx = createContext(cfg);
const { log, tasks } = ctx;
const count = Number(process.argv[2]) || 20;
const golden = readGolden(model);
const challengerId = readJSON(`prompts/${model}/active.json`, [])[0];
const prompts = [golden, challengerId && { id: challengerId, text: readText(`prompts/${model}/${challengerId}.md`).trim() }].filter(Boolean);
const pub = cfg.publication || {};
const checker = pub.judge === "judge" ? cfg.writer.judge : cfg.writer.screenJudge;
log(`adding ${count} quiz articles for prompts ${prompts.map((p) => promptName(p.id)).join(" and ")}; writer ${cfg.writer.model}, publication check by ${checker.model}`);

const record = { date: today(), writer: { name: cfg.writer.name, model: cfg.writer.model, effort: cfg.writer.effort }, prompts: prompts.map((p) => p.id), publication: { rules: pub, checker }, articles: [], dropped: [] };
let ok = [];
try {
  const articles = await prepareArticles(ctx, count, existingSlugs(), { baseline: false });
  const runs = await Promise.all(prompts.map((p) => runPrompt(ctx, p.text, articles, { judge: false })));

  // Publication checks, per summary.
  const checked = await pool(articles, cfg.concurrency, async (a) => {
    const results = [];
    for (const [i, p] of prompts.entries()) {
      const r = runs[i].find((x) => x.slug === a.slug);
      const j = await tasks.judge(a, [], r.summary, { ...checker, role: "publication" });
      const flagged = pub.moderation ? await tasks.moderate(r.summary).catch(() => null) : false;
      const problems = [];
      if (pub.unsupported && j.unsupported > pub.unsupported.max) problems.push(`${j.unsupported} unsupported claim${j.unsupported === 1 ? "" : "s"}`);
      if (flagged === true) problems.push("flagged by moderation");
      if (flagged === null) problems.push("moderation check failed");
      results.push({ prompt: p.id, words: r.words, dashes: r.dashes, unsupported: j.unsupported, unsupportedClaims: j.unsupportedClaims, style: j.style, styleIssues: j.styleIssues, flagged, problems });
    }
    return { a, results, pass: results.every((x) => !x.problems.length) };
  });
  for (const c of checked) {
    const entry = { slug: c.a.slug, title: c.a.source.title, revision: c.a.source.revision, checks: c.results };
    if (c.pass) record.articles.push(entry);
    else {
      record.dropped.push(entry);
      log(`left out ${c.a.slug}: ${c.results.flatMap((x) => x.problems.map((p) => `prompt ${promptName(x.prompt)} ${p}`)).join("; ")}`);
    }
  }
  const passing = checked.filter((c) => c.pass).map((c) => c.a);
  ok = await addQuestions(ctx, passing, runs);
  const asked = new Set(ok.map((a) => a.slug));
  for (const e of record.articles) e.question = asked.has(e.slug);

  for (const a of ok) {
    const dir = `content/articles/${a.slug}`;
    writeJSON(`${dir}/source.json`, a.source);
    writeJSON(`${dir}/points.json`, { points: [], key: [], question: a.question });
    prompts.forEach((p, i) => {
      const r = runs[i].find((x) => x.slug === a.slug);
      if (r) writeJSON(`${dir}/${model}/${p.id}.json`, r);
    });
  }
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  record.budgetNote = e.message;
  log(e.message);
}

record.published = ok.map((a) => a.slug);
record.usd = Math.round(ctx.budget.usd * 1000) / 1000;
record.byModel = ctx.budget.byModel;
record.byRole = ctx.budget.byRole;
const recordPath = `evals/${record.date}-articles.json`;
const earlier = readJSON(recordPath, null);
writeJSON(recordPath, earlier ? { runs: [...(earlier.runs || [earlier]), record] } : record);

const title = `Add ${ok.length} quiz articles (prompts ${prompts.map((p) => promptName(p.id)).join(" and ")})`;
log(`${title}. ${record.dropped.length} left out by the publication checks. Spent $${ctx.budget.usd.toFixed(3)} (${spendLine(ctx.budget)}).`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `title=${title}\n`);
