// Build the deployable site in _site/: static files, content/index.json, js/config.js,
// and the current golden prompt baked into index.html (so it shows without JavaScript).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { REPO, ROOT } from "./lib/config.js";
import { readJSON, readGolden } from "./lib/store.js";
import { readPrinciples, injectPrinciples } from "./lib/principles.js";
import { injectModels } from "./lib/models-table.js";
import { buildExamples } from "./lib/examples.js";
import { loadConfig } from "./lib/config.js";

const OUT = path.join(REPO, "_site");
const LABELS = { openai: "OpenAI" };
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const models = fs
  .readdirSync(path.join(ROOT, "prompts"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "queue" && fs.existsSync(path.join(ROOT, "prompts", d.name, "golden.json")))
  .map((d) => d.name);

// Latest weekly eval report: its numbers back the claim on the page, and it lists this week's articles.
const reports = fs.existsSync(path.join(ROOT, "evals"))
  ? fs.readdirSync(path.join(ROOT, "evals")).filter((f) => /^\d{4}-\d{2}-\d{2}(-seed)?\.json$/.test(f)).sort()
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
    if (!question) continue; // no question answerable from every summary: not in the quiz
    articles.push({ slug, title: src.title, url: src.url, question: { text: question.text, options: question.options, answer: question.answer }, summaries });
  }

  // Claim numbers: this week's search-set result for golden, else the latest golden-only check.
  let evalNumbers = null;
  if (latest?.golden?.id === golden.id && latest.golden.score) {
    evalNumbers = { date: latest.date, coverage: latest.golden.score.coverage, shorter: 1 - latest.golden.score.lengthRatio, density: latest.golden.score.density, articles: latest.golden.score.n, passed: latest.golden.passed, writerModel: latest.writerModel, judgeModel: latest.judgeModel };
  } else if (goldenEvals.length) {
    const g = readJSON(`evals/${goldenEvals.at(-1)}`);
    if (g.golden === golden.id) evalNumbers = { date: g.date, coverage: g.score.coverage, shorter: 1 - g.score.lengthRatio, density: g.score.density, articles: g.score.n, passed: g.passed, writerModel: g.writerModel, judgeModel: g.judgeModel };
  }

  index.models[model] = { label: LABELS[model] || model, golden, challenger, eval: evalNumbers, articles };
}

// Write _site.
fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ["css", "js"]) fs.cpSync(path.join(REPO, d), path.join(OUT, d), { recursive: true });
fs.copyFileSync(path.join(REPO, "favicon.svg"), path.join(OUT, "favicon.svg"));
fs.mkdirSync(path.join(OUT, "content"), { recursive: true });
fs.writeFileSync(path.join(OUT, "content/index.json"), JSON.stringify(index));

// Public read API for the golden prompt (served by GitHub Pages, and by api.slopfree.ca/v1/golden).
const cfgNow = loadConfig();
const goldenDoc = (model) => {
  const m = index.models[model];
  return {
    prompt: m.golden.text,
    name: String(Number(m.golden.id.replace(/^p-/, ""))),
    file: `prompts/${model}/${m.golden.id}.md`,
    provider: model,
    tunedFor: { writer: cfgNow.writerModel, judge: cfgNow.judgeModel },
    eval: m.eval,
    challenger: m.challenger ? String(Number(m.challenger.replace(/^p-/, ""))) : null,
    updated: index.generated,
    source: `https://github.com/mvpete/slopfree-ca/blob/main/prompts/${model}/${m.golden.id}.md`,
    license: "MIT",
  };
};
fs.mkdirSync(path.join(OUT, "api/golden"), { recursive: true });
for (const model of models) fs.writeFileSync(path.join(OUT, `api/golden/${model}.json`), JSON.stringify(goldenDoc(model), null, 2));
fs.writeFileSync(path.join(OUT, "golden.json"), JSON.stringify({ ...goldenDoc(models[0]), models: Object.fromEntries(models.map((m) => [m, goldenDoc(m)])) }, null, 2));
fs.writeFileSync(path.join(OUT, "golden.txt"), index.models[models[0]].golden.text + "\n");

// The Examples page uses the same menu as the home page, so the two never drift apart.
const homeNav = fs.readFileSync(path.join(REPO, "index.html"), "utf8").match(/<nav aria-label="Main">[\s\S]*?<\/nav>/)[0];
const examplesNav = homeNav
  .replace(/href="#/g, 'href="./#')
  .replace(/ data-section="[^"]*"/g, "")
  .replace('<a href="examples.html">', '<a href="examples.html" class="active" aria-current="page">');

// Examples page: this week's eval articles, plain vs golden (vs challenger), side by side.
{
  const model = models[0];
  const m = index.models[model];
  const all = fs.existsSync(path.join(ROOT, "content/articles")) ? fs.readdirSync(path.join(ROOT, "content/articles")) : [];
  const slugs = latest?.model === model && latest.contentSlugs?.length ? latest.contentSlugs.filter((s) => all.includes(s)) : all;
  fs.writeFileSync(
    path.join(OUT, "examples.html"),
    buildExamples(ROOT, model, m.golden, m.challenger, slugs, { date: latest?.date, writer: latest?.writerModel || cfgNow.writerModel, judge: latest?.judgeModel || cfgNow.judgeModel, nav: examplesNav, wrapper: cfgNow.wrapper, challengerText: m.challenger ? fs.readFileSync(path.join(ROOT, `prompts/${model}/${m.challenger}.md`), "utf8").trim() : null })
  );
}
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
fs.writeFileSync(
  path.join(OUT, "js/config.js"),
  `window.SLOPFREE_CONFIG = ${JSON.stringify({ api: process.env.SLOPFREE_API_URL || "", turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "" })};\n`
);

const first = index.models[models[0]];
let html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
html = injectPrinciples(html, readPrinciples(REPO));
html = injectModels(html, loadConfig());
html = html.replace(/(<pre id="golden"><code>)[\s\S]*?(<\/code><\/pre>)/, `$1${esc(first.golden.text)}$2`);
// The How to use example shows the start of the current golden prompt.
html = html.replace(/(<span id="snippet-golden">)[\s\S]*?(<\/span>)/, `$1${esc(first.golden.text.split("\n").slice(0, 2).join("\n"))} ...$2`);
fs.writeFileSync(path.join(OUT, "index.html"), html);

// Versioned asset URLs, applied last: a browser can never pair a new page with an old cached script or stylesheet.
const ver = (rel) => createHash("sha256").update(fs.readFileSync(path.join(OUT, rel))).digest("hex").slice(0, 10);
for (const page of ["index.html", "examples.html"]) {
  const p = path.join(OUT, page);
  if (!fs.existsSync(p)) continue;
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/(href|src)="(css\/styles\.css|js\/main\.js|js\/config\.js)"/g, (_, attr, rel) => `${attr}="${rel}?v=${ver(rel)}"`));
}

console.log(`Built _site: ${models.length} model(s); ${models.map((m) => `${m}: golden ${index.models[m].golden.id}, challenger ${index.models[m].challenger || "none"}, ${index.models[m].articles.length} articles`).join("; ")}`);
