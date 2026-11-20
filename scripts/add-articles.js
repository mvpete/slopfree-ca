// Add quiz-only articles to the current trial: both prompts' summaries and a question every summary answers.
// No point lists, no baseline, no grading, so it's cheap.
//
//   node scripts/add-articles.js [count]     (default 20)
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./lib/config.js";
import { createContext, prepareArticles, runPrompt, addQuestions } from "./lib/eval.js";
import { readJSON, readGolden, readText, existingSlugs, writeJSON } from "./lib/store.js";
import { promptName } from "./lib/util.js";

const cfg = loadConfig();
const ctx = createContext(cfg);
const model = cfg.model;
const count = Number(process.argv[2]) || 20;
const golden = readGolden(model);
const challengerId = readJSON(`prompts/${model}/active.json`, [])[0];
const prompts = [golden, challengerId && { id: challengerId, text: readText(`prompts/${model}/${challengerId}.md`).trim() }].filter(Boolean);
ctx.log(`adding ${count} quiz articles for prompts ${prompts.map((p) => promptName(p.id)).join(" and ")}`);

const articles = await prepareArticles(ctx, count, existingSlugs(), { baseline: false });
const runs = await Promise.all(prompts.map((p) => runPrompt(ctx, p.text, articles, { judge: false })));
const ok = await addQuestions(ctx, articles, runs);

for (const a of ok) {
  const dir = `content/articles/${a.slug}`;
  writeJSON(`${dir}/source.json`, a.source);
  writeJSON(`${dir}/points.json`, { points: [], key: [], question: a.question });
  prompts.forEach((p, i) => {
    const r = runs[i].find((x) => x.slug === a.slug);
    if (r) writeJSON(`${dir}/${model}/${p.id}.json`, r);
  });
}

// Add them to the latest report's article list, which is what the site serves.
const evalsDir = path.join(ROOT, "evals");
const latest = fs.existsSync(evalsDir) ? fs.readdirSync(evalsDir).filter((f) => /^\d{4}-\d{2}-\d{2}(-seed)?\.json$/.test(f)).sort().at(-1) : null;
if (latest) {
  const report = readJSON(`evals/${latest}`);
  report.contentSlugs = [...new Set([...(report.contentSlugs || []), ...ok.map((a) => a.slug)])];
  report.added = [...(report.added || []), { count: ok.length, tokens: ctx.budget.used, tokensByModel: ctx.budget.byModel }];
  writeJSON(`evals/${latest}`, report);
}

const title = `Add ${ok.length} quiz articles (prompts ${prompts.map((p) => promptName(p.id)).join(" and ")})`;
ctx.log(`${title}. Tokens: ${ctx.budget.used.toLocaleString()} ${JSON.stringify(ctx.budget.byModel)}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `title=${title}\n`);
