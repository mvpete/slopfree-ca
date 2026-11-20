// Build the deployable site in _site/: static files, content/index.json, js/config.js,
// and the current golden prompt baked into index.html (so it shows without JavaScript).
import fs from "node:fs";
import path from "node:path";
import { REPO, ROOT } from "./lib/config.js";
import { readJSON, readGolden } from "./lib/store.js";
import { readPrinciples, injectPrinciples } from "./lib/principles.js";

const OUT = path.join(REPO, "_site");
const LABELS = { openai: "OpenAI" };
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const models = fs
  .readdirSync(path.join(ROOT, "prompts"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "queue" && fs.existsSync(path.join(ROOT, "prompts", d.name, "golden.json")))
  .map((d) => d.name);

// Latest weekly eval report: its numbers back the claim on the page, and it lists this week's articles.
const reports = fs.existsSync(path.join(ROOT, "evals"))
  ? fs.readdirSync(path.join(ROOT, "evals")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
  : [];
const latest = reports.length ? readJSON(`evals/${reports.at(-1)}`) : null;
const goldenEvals = fs.existsSync(path.join(ROOT, "evals"))
  ? fs.readdirSync(path.join(ROOT, "evals")).filter((f) => /^golden-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
  : [];

const index = { generated: new Date().toISOString(), models: {} };
for (const model of models) {
  const golden = readGolden(model);
  const challenger = readJSON(`prompts/${model}/active.json`, [])[0] || null;
  const dir = path.join(ROOT, "content/articles");
  const all = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const wanted = latest?.model === model && latest.contentSlugs?.length ? latest.contentSlugs.filter((s) => all.includes(s)) : all;

  const articles = [];
  for (const slug of wanted) {
    const summaries = {};
    for (const id of [golden.id, challenger].filter(Boolean)) {
      const r = readJSON(`content/articles/${slug}/${model}/${id}.json`, null);
      if (r) summaries[id] = r.summary;
    }
    if (!summaries[golden.id]) continue;
    const src = readJSON(`content/articles/${slug}/source.json`);
    const { question } = readJSON(`content/articles/${slug}/points.json`);
    articles.push({ slug, title: src.title, url: src.url, question: { text: question.text, options: question.options, answer: question.answer }, summaries });
  }

  // Claim numbers: this week's search-set result for golden, else the latest golden-only check.
  let evalNumbers = null;
  if (latest?.golden?.id === golden.id && latest.golden.score) {
    evalNumbers = { date: latest.date, coverage: latest.golden.score.coverage, shorter: 1 - latest.golden.score.lengthRatio, articles: latest.golden.score.n, passed: latest.golden.passed };
  } else if (goldenEvals.length) {
    const g = readJSON(`evals/${goldenEvals.at(-1)}`);
    if (g.golden === golden.id) evalNumbers = { date: g.date, coverage: g.score.coverage, shorter: 1 - g.score.lengthRatio, articles: g.score.n, passed: g.passed };
  }

  index.models[model] = { label: LABELS[model] || model, golden, challenger, eval: evalNumbers, articles };
}

// Write _site.
fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ["css", "js"]) fs.cpSync(path.join(REPO, d), path.join(OUT, d), { recursive: true });
fs.copyFileSync(path.join(REPO, "favicon.svg"), path.join(OUT, "favicon.svg"));
fs.mkdirSync(path.join(OUT, "content"), { recursive: true });
fs.writeFileSync(path.join(OUT, "content/index.json"), JSON.stringify(index));
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
fs.writeFileSync(
  path.join(OUT, "js/config.js"),
  `window.SLOPFREE_CONFIG = ${JSON.stringify({ api: process.env.SLOPFREE_API_URL || "", turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "" })};\n`
);

const first = index.models[models[0]];
let html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
html = injectPrinciples(html, readPrinciples(REPO));
html = html.replace(/(<pre id="golden"><code>)[\s\S]*?(<\/code><\/pre>)/, `$1${esc(first.golden.text)}$2`);
fs.writeFileSync(path.join(OUT, "index.html"), html);

console.log(`Built _site: ${models.length} model(s); ${models.map((m) => `${m}: golden ${index.models[m].golden.id}, challenger ${index.models[m].challenger || "none"}, ${index.models[m].articles.length} articles`).join("; ")}`);
