// Weekly reader-test decision. Runs before weekly-topics.js in the same job.
//
// Data comes from the scoring API (SLOPFREE_API_URL + SLOPFREE_EXPORT_TOKEN),
// or from a local file (ANSWERS_FILE) for testing.
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./lib/config.js";
import { readJSON, writeJSON, readGolden, writeLoser } from "./lib/store.js";
import { decide } from "./lib/decide.js";
import { today, pct } from "./lib/util.js";

const cfg = loadConfig();
const model = cfg.model;
const date = today();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const active = readJSON(`prompts/${model}/active.json`, []);
const golden = readGolden(model);
const cacheDir = path.join(ROOT, ".cache");
fs.mkdirSync(cacheDir, { recursive: true });

function finish(summary) {
  fs.writeFileSync(path.join(cacheDir, "decision.json"), JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `decision=${summary.outcome}\n`);
  log(summary.title);
}

if (!active.length) {
  finish({ outcome: "none", title: "No challenger to decide", body: "" });
  process.exit(0);
}
const challenger = active[0];

async function loadRows() {
  if (process.env.ANSWERS_FILE) return JSON.parse(fs.readFileSync(process.env.ANSWERS_FILE, "utf8")).rows;
  const api = process.env.SLOPFREE_API_URL;
  if (!api) {
    log("SLOPFREE_API_URL not set: no reader data, so this week counts as thin");
    return [];
  }
  const res = await fetch(`${api.replace(/\/$/, "")}/v1/export?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${process.env.SLOPFREE_EXPORT_TOKEN || ""}` },
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status} ${await res.text()}`); // fail the job; don't lose a trial to an outage
  return (await res.json()).rows;
}

const rows = (await loadRows()).filter((r) => r.prompt_id === golden.id || r.prompt_id === challenger);

// Answer key from the repo, so a client can't mark its own answers correct.
const key = {};
for (const slug of new Set(rows.map((r) => r.slug))) {
  const p = readJSON(`content/articles/${slug}/points.json`, null);
  if (p) key[slug] = p.question.answer;
}

const snapshot = `data/answers-${date}.json`;
writeJSON(snapshot, { date, model, golden: golden.id, challenger, rows });

const seed = `${date}:${golden.id}:${challenger}`;
const result = decide(rows, { golden: golden.id, challenger, key, seed });
writeJSON(`evals/${date}-decision.json`, { date, model, golden: golden.id, challenger, seed, snapshot, ...result });

const n = result.numbers;
const table = `| | Answers | Accuracy |
|---|---|---|
| Golden ${golden.id} | ${n.answers.golden} | ${pct(n.accuracy.golden)} |
| Challenger ${challenger} | ${n.answers.challenger} | ${pct(n.accuracy.challenger)} |

${n.all ? `Paired sessions: ${n.all.sessions}. Chance it was better: ${pct(n.all.pBetter)}.` : "No sessions saw both prompts."}`;

const challengerText = fs.readFileSync(path.join(ROOT, `prompts/${model}/${challenger}.md`), "utf8").trim();
let title;
if (result.outcome === "win") {
  writeLoser(model, { id: golden.id, date, stage: `reader test (replaced by ${challenger})`, reason: result.reason, table, prompt: golden.text, report: `evals/${date}-decision.json` });
  fs.rmSync(path.join(ROOT, `prompts/${model}/${golden.id}.md`));
  writeJSON(`prompts/${model}/golden.json`, { id: challenger });
  title = `${challenger} is the new golden prompt`;
} else {
  writeLoser(model, { id: challenger, date, stage: "reader test", reason: result.reason, table, prompt: challengerText, report: `evals/${date}-decision.json` });
  fs.rmSync(path.join(ROOT, `prompts/${model}/${challenger}.md`));
  title = `${challenger} lost the reader test; ${golden.id} stays golden`;
}
writeJSON(`prompts/${model}/active.json`, []);

finish({
  outcome: result.outcome,
  title,
  body: `### Reader test: ${title}\n\n${result.reason}\n\n${table}\n\nData: \`${snapshot}\`. Decision: \`evals/${date}-decision.json\`.\n`,
});
