// Rewrite the current quiz questions from the summaries readers see, and restart answer counting.
// Each new question is about a fact every prompt's summary states, checked by quotation.
import { loadConfig, ROOT } from "./lib/config.js";
import { createContext, addQuestions } from "./lib/eval.js";
import { readJSON, writeJSON, readGolden } from "./lib/store.js";
import fs from "node:fs";
import path from "node:path";

const cfg = loadConfig();
const ctx = createContext(cfg);
const model = cfg.model;
const golden = readGolden(model);
const challenger = readJSON(`prompts/${model}/active.json`, [])[0];
const ids = [golden.id, challenger].filter(Boolean);

const dir = path.join(ROOT, "content/articles");
const slugs = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
const articles = [];
const runs = ids.map(() => []);
for (const slug of slugs) {
  const summaries = ids.map((id) => readJSON(`content/articles/${slug}/${model}/${id}.json`, null));
  if (summaries.some((s) => !s)) continue;
  articles.push({ slug, source: readJSON(`content/articles/${slug}/source.json`) });
  summaries.forEach((s, i) => runs[i].push({ slug, summary: s.summary }));
}
ctx.log(`rewriting questions for ${articles.length} articles (prompts ${ids.join(", ")})`);

const ok = await addQuestions(ctx, articles, runs);
const kept = new Set(ok.map((a) => a.slug));
for (const a of articles) {
  const rel = `content/articles/${a.slug}/points.json`;
  const p = readJSON(rel);
  if (kept.has(a.slug)) p.question = a.question;
  else delete p.question; // leaves the quiz
  writeJSON(rel, p);
}

// Start counting answers from now, so answers to the old questions are ignored.
const trialPath = `prompts/${model}/trial.json`;
const trial = readJSON(trialPath, null);
if (trial) writeJSON(trialPath, { ...trial, countFrom: new Date().toISOString() });

ctx.log(`${ok.length} of ${articles.length} articles have a question every summary answers. Tokens: ${ctx.budget.used.toLocaleString()}`);
const title = `Rewrite quiz questions from the summaries (${ok.length} of ${articles.length} articles)`;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `title=${title}\n`);
