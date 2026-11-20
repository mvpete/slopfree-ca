// One-off: build a week of quiz content for the current golden and challenger, without a search.
// Used to start a trial from hand-picked seed prompts.
//
//   10 eval articles: points, plain baseline, both prompts, all graded (the numbers on the site and Examples page)
//   20 quiz articles: points and both prompts' summaries, no baseline or grading (just enough for the quiz)
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./lib/config.js";
import { createContext, prepareArticles, runPrompt, scoreRuns, addQuestions, BudgetExceeded } from "./lib/eval.js";
import { readJSON, readGolden, readText, existingSlugs, writeJSON } from "./lib/store.js";
import { reasonOf } from "./lib/gate.js";
import { today, promptName } from "./lib/util.js";

const cfg = loadConfig();
const ctx = createContext(cfg);
const { log } = ctx;
const model = cfg.model;
const date = today();
const golden = readGolden(model);
const challengerId = readJSON(`prompts/${model}/active.json`, [])[0];
if (!challengerId) throw new Error("No challenger in active.json");
const challenger = { id: challengerId, text: readText(`prompts/${model}/${challengerId}.md`).trim() };
log(`seed content: golden ${golden.id}, challenger ${challenger.id}; writer ${cfg.writerModel}; judge ${cfg.judgeModel}`);

const exclude = existingSlugs();
const byslug = (runs) => Object.fromEntries(runs.map((r) => [r.slug, r]));
const report = { date, model, writerModel: cfg.writerModel, judgeModel: cfg.judgeModel, gate: cfg.gate, seed: true };

function write(articles, runs) {
  for (const a of articles) {
    const dir = `content/articles/${a.slug}`;
    writeJSON(`${dir}/source.json`, a.source);
    writeJSON(`${dir}/points.json`, { points: a.points, key: a.key, question: a.question });
    if (a.baseline) writeJSON(`${dir}/baseline.json`, a.baseline);
    for (const [id, r] of Object.entries(runs)) if (r[a.slug]) writeJSON(`${dir}/${model}/${id}.json`, r[a.slug]);
  }
}

try {
  const evalSet = await prepareArticles(ctx, cfg.articles, exclude);
  const [g, c] = await Promise.all([runPrompt(ctx, golden.text, evalSet), runPrompt(ctx, challenger.text, evalSet)]);
  const gs = scoreRuns(cfg, evalSet, g);
  const cs = scoreRuns(cfg, evalSet, c);
  report.golden = { id: golden.id, score: gs.score, passed: gs.gate.passed, reason: reasonOf(gs.gate), stats: gs.stats };
  report.challenger = { id: challenger.id, score: cs.score, passed: cs.gate.passed, reason: reasonOf(cs.gate), stats: cs.stats };
  log(`prompt ${promptName(golden.id)}: ${gs.gate.passed ? "passes" : "fails"}: ${reasonOf(gs.gate)}`);
  log(`prompt ${promptName(challenger.id)}: ${cs.gate.passed ? "passes" : "fails"}: ${reasonOf(cs.gate)}`);
  const evalQuiz = await addQuestions(ctx, evalSet, [g, c]);
  write(evalSet, { [golden.id]: byslug(g), [challenger.id]: byslug(c) });
  report.contentSlugs = evalQuiz.map((a) => a.slug);

  const extra = Math.max(0, cfg.quizArticles - evalSet.length);
  if (extra) {
    const quiz = await prepareArticles(ctx, extra, exclude, { baseline: false });
    const [gq, cq] = await Promise.all([runPrompt(ctx, golden.text, quiz, { judge: false }), runPrompt(ctx, challenger.text, quiz, { judge: false })]);
    const quizOk = await addQuestions(ctx, quiz, [gq, cq]);
    write(quizOk, { [golden.id]: byslug(gq), [challenger.id]: byslug(cq) });
    report.contentSlugs.push(...quizOk.map((a) => a.slug));
  }
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  report.budgetNote = e.message;
  log(e.message);
}

report.tokensUsed = ctx.budget.used;
report.tokensByModel = ctx.budget.byModel;
writeJSON(`evals/${date}-seed.json`, report);

const line = (r) => (r ? `Prompt ${promptName(r.id)}: ${r.passed ? "passes" : "fails"} the eval. ${r.reason}` : "");
const title = `Seed trial: prompt ${promptName(golden.id)} vs prompt ${promptName(challenger.id)} (${report.contentSlugs?.length || 0} quiz articles)`;
const body = `## ${title}

Summaries by \`${cfg.writerModel}\`, judged by \`${cfg.judgeModel}\`.

- ${line(report.golden)}
- ${line(report.challenger)}

Seed prompts are picked by Claude at the maintainer's request, so they enter the reader trial whether or not they pass the eval. The trial is decided on the date in \`prompts/${model}/trial.json\`.

Tokens used: ${ctx.budget.used.toLocaleString()} (${Object.entries(ctx.budget.byModel).map(([m, t]) => `${m}: ${t.input.toLocaleString()} in, ${t.output.toLocaleString()} out`).join("; ")}).
`;
const cache = path.join(ROOT, ".cache");
fs.mkdirSync(cache, { recursive: true });
fs.writeFileSync(path.join(cache, "seed-body.md"), body);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `title=${title}\nbody_path=${path.join(cache, "seed-body.md")}\n`);
log(title);
