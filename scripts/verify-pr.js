// CI guardrails for bot PRs. Auto-merge only happens if this passes.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig, ROOT } from "./lib/config.js";
import { score, checkGate, reasonOf } from "./lib/gate.js";
import { decide } from "./lib/decide.js";

const cfg = loadConfig();
const base = process.env.BASE_REF || "main";
const isBot = process.env.BOT_PR === "true";
const changed = execSync(`git diff --name-only origin/${base}...HEAD`, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const file = (f) => path.join(ROOT, f);
const exists = (f) => fs.existsSync(file(f));
const json = (f) => JSON.parse(fs.readFileSync(file(f), "utf8"));
const errors = [];

if (isBot) {
  for (const f of changed) if (!/^(prompts|content|evals|data)\//.test(f)) errors.push(`Bot PRs may not change ${f}`);
}

for (const f of changed.filter((f) => /^prompts\/[^/]+\/p-\d+\.md$/.test(f) && exists(f))) {
  const len = fs.readFileSync(file(f), "utf8").trim().length;
  if (len > cfg.promptMaxChars) errors.push(`${f} is ${len} characters (limit ${cfg.promptMaxChars})`);
}

// Eval: re-check the gate from the stored per-article numbers instead of trusting the verdict.
for (const f of changed.filter((f) => /^evals\/\d{4}-\d{2}-\d{2}\.json$/.test(f) && exists(f))) {
  const report = json(f);
  if (report.outcome !== "challenger") continue;
  const c = report.challenger;
  for (const stage of ["search", "confirm"]) {
    const result = checkGate(score(c[stage].stats), report.gate);
    if (!result.passed) errors.push(`${f}: challenger fails the gate on ${stage}: ${reasonOf(result)}`);
  }
  const active = json(`prompts/${report.model}/active.json`);
  if (!active.includes(c.id)) errors.push(`${f}: challenger ${c.id} is not in active.json`);
  if (!exists(`prompts/${report.model}/${c.id}.md`)) errors.push(`${f}: prompts/${report.model}/${c.id}.md is missing`);
}

// Reader test: recompute the decision from the data snapshot and the repo's answer key.
for (const f of changed.filter((f) => /^evals\/\d{4}-\d{2}-\d{2}-decision\.json$/.test(f) && exists(f))) {
  const d = json(f);
  const snap = json(d.snapshot);
  const key = {};
  for (const slug of new Set(snap.rows.map((r) => r.slug))) {
    const p = `content/articles/${slug}/points.json`;
    if (exists(p)) key[slug] = json(p).question.answer;
  }
  const again = decide(snap.rows, { golden: d.golden, challenger: d.challenger, key, seed: d.seed });
  if (again.outcome !== d.outcome) errors.push(`${f}: says ${d.outcome}, but the data gives ${again.outcome}`);
  const golden = json(`prompts/${d.model}/golden.json`).id;
  const expected = d.outcome === "win" ? d.challenger : d.golden;
  if (golden !== expected) errors.push(`${f}: golden.json is ${golden}, expected ${expected}`);
  if (!exists(`prompts/${d.model}/losers/${d.outcome === "win" ? d.golden : d.challenger}.md`)) errors.push(`${f}: missing loser file`);
}

if (errors.length) {
  console.error("PR checks failed:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(`PR checks passed (${changed.length} files${isBot ? ", bot PR" : ""}).`);
