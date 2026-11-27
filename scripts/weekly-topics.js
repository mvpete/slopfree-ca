// Weekly search: pick this week's challenger for the reader test.
//
//   node scripts/weekly-topics.js            real run (needs OPENAI_API_KEY and ANTHROPIC_API_KEY)
//   DRY_RUN=1 SLOPFREE_ROOT=/tmp/x node scripts/weekly-topics.js
//
// One writer per run, picked from the date (cfg.writerPick); the other model family judges it.
//   1. Pool: community submissions, then last run's unpicked candidates, then the drafter fills the
//      rest (one call, only if the pool is short).
//   2. Search set: answer keys, the plain summary, graded.
//   3. Screen every candidate on cfg.articles.screen articles with the cheap judge, rank them
//      (scripts/lib/qualify.js rank(), against cfg.screening).
//   4. Finalists, best first: graded by the main judge on the whole search set, then on unseen
//      articles. The first to meet every target (cfg.targets) on both is the challenger.
//   5. If none does, the best finalist goes forward anyway. Targets are goals, not gates: every miss
//      and its distance is recorded and shown in the PR. Readers decide.
//   6. Publication checks (cfg.publication) on every summary readers will see; golden graded on the
//      unseen articles for the fight card only (never used to pick).
// Every stage's cost is estimated first and skipped if it won't fit the budget. A skipped stage
// never means no challenger: the best candidate measured so far goes forward.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig, configSnapshot, ROOT, REPO } from "./lib/config.js";
import { createContext, prepareArticles, runPrompt, rejudge, addQuestions, BudgetExceeded } from "./lib/eval.js";
import { readGolden, readJSON, nextPromptId, existingSlugs, writeJSON, writeText, writeLoser } from "./lib/store.js";
import { measure, qualify, objectiveScore, rank, reasonOf } from "./lib/qualify.js";
import { planCost, stages } from "./lib/estimate.js";
import { publicationChecks } from "./lib/publish.js";
import { PROMPTS, describeCriteria } from "./lib/tasks.js";
import { spendLine } from "./lib/llm.js";
import { today, pct, promptName, QUEUE_NAME } from "./lib/util.js";

const date = process.env.RUN_DATE || today();
const cfg = loadConfig({ seed: date }); // the writer is picked from the run date
const ctx = createContext(cfg);
const { tasks, log, budget } = ctx;
const model = cfg.model;
const writer = cfg.writer;
const evalsDir = path.join(ROOT, "evals");

// Never overwrite an existing report: a second run on the same day gets its own file.
let reportName = date;
for (let k = 2; fs.existsSync(path.join(evalsDir, `${reportName}.json`)); k++) reportName = `${date}-run${k}`;
const reportPath = `evals/${reportName}.json`;

const golden = readGolden(model);
const commit = (() => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim(); } catch { return null; }
})();
const sdk = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, "node_modules/@anthropic-ai/sdk/package.json"), "utf8")).version; } catch { return null; }
})();

log(`golden ${golden.id}; writer ${writer.name} (${writer.model}), judged by ${writer.judge.model}; picked ${cfg.writerPick.method}${cfg.writerPick.seed ? ` from ${cfg.writerPick.seed}` : ""}${cfg.dryRun ? " (dry run)" : ""}`);

const report = {
  schemaVersion: 2,
  kind: "weekly",
  date,
  model,
  config: configSnapshot(cfg),
  prompts: PROMPTS,
  code: { commit, anthropicSdk: sdk },
  writer,
  writerPick: cfg.writerPick,
  golden: { id: golden.id },
  articles: { search: [], confirm: [] },
  candidates: [],
  estimates: [],
  skipped: [],
  outcome: "none",
};

// ---- budget ---------------------------------------------------------------------------------------

const prices = cfg.budget.prices;
const safety = cfg.budget.safety ?? 1.2;
const words = (set) => (set?.length ? Math.round(set.reduce((a, x) => a + x.source.words, 0) / set.length) : 2400);
// Estimate a stage; skip it (and record why) if it won't fit what's left.
function fits(label, plan) {
  const usd = planCost(prices, plan, { observed: budget.byRole, assumed: cfg.budget.assumedOutputTokens });
  const left = budget.left;
  report.estimates.push({ label, usd: Math.round(usd * 1000) / 1000, left: Math.round(left * 1000) / 1000 });
  if (usd * safety > left) {
    report.skipped.push({ label, estimate: usd, left });
    log(`skipped ${label}: needs about $${usd.toFixed(2)}, $${left.toFixed(2)} left`);
    return false;
  }
  return true;
}
const scfg = { ...cfg, writers: [writer] };

// ---- 1. candidate pool -----------------------------------------------------------------------------

const knownTexts = new Set(
  fs.readdirSync(path.join(ROOT, `prompts/${model}`)).filter((f) => /^p-\d+\.md$/.test(f)).map((f) => fs.readFileSync(path.join(ROOT, `prompts/${model}`, f), "utf8").trim())
);
const queueDir = path.join(ROOT, "prompts/queue");
const queue = fs.existsSync(queueDir)
  ? fs.readdirSync(queueDir).map((f) => ({ f, m: f.match(QUEUE_NAME) })).filter((x) => x.m).sort((a, b) => a.m[2].localeCompare(b.m[2]) || a.f.localeCompare(b.f)).map((x) => `prompts/queue/${x.f}`)
  : [];

// The latest earlier weekly report: its candidates that weren't picked can compete again.
function previousReport() {
  if (!fs.existsSync(evalsDir)) return null;
  const f = fs.readdirSync(evalsDir).filter((x) => /^\d{4}-\d{2}-\d{2}(-run\d+)?\.json$/.test(x) && x.replace(".json", "") < reportName).sort().at(-1);
  return f ? { file: `evals/${f}`, report: JSON.parse(fs.readFileSync(path.join(evalsDir, f), "utf8")) } : null;
}
const prev = cfg.search.reuse ? previousReport() : null;
function reusable(p) {
  if (!p) return [];
  const r = p.report;
  const list = r.schemaVersion === 2
    ? (r.candidates || []).filter((c) => !c.selected).map((c) => ({ prompt: c.prompt, idea: c.idea, from: { report: p.file, candidate: c.n, distance: c.full?.targets?.distance ?? c.screen?.ranking?.distance ?? Infinity } }))
    : (r.attempts || []).filter((a) => a.prompt && !a.passed).map((a) => ({ prompt: a.prompt, idea: a.idea, from: { report: p.file, candidate: a.n, distance: a.distance ?? Infinity } }));
  return list.sort((a, b) => a.from.distance - b.from.distance);
}

// What went wrong last time, in words, for the drafter.
function feedbackFrom(p) {
  if (!p) return "";
  const r = p.report;
  if (r.schemaVersion !== 2) {
    const lost = (r.attempts || []).filter((a) => a.prompt && a.reason).slice(-8);
    return lost.length ? "EARLIER ATTEMPTS AND WHY THEY FELL SHORT:\n\n" + lost.map((a) => `${a.reason}\n${a.prompt}`).join("\n\n---\n\n") : "";
  }
  const pts = Object.fromEntries([...(r.articles?.search || []), ...(r.articles?.confirm || [])].map((a) => [a.slug, a]));
  const parts = (r.candidates || []).slice(0, 6).map((c) => {
    const st = c.full || c.screen;
    if (!st) return null;
    const missed = st.runs.flatMap((run) => run.covered.map((k, i) => (!k ? pts[run.slug]?.points?.[i] : null)).filter(Boolean)).slice(0, 8);
    const claims = st.runs.flatMap((run) => run.unsupportedClaims || []).slice(0, 5);
    const style = st.runs.flatMap((run) => run.styleIssues || []).slice(0, 5);
    return [`Missed targets: ${st.targets.reason}`, missed.length && `Dropped important points: ${missed.map((m) => `"${m}"`).join("; ")}`, claims.length && `Made-up claims: ${claims.map((m) => `"${m}"`).join("; ")}`, style.length && `Flagged phrases: ${style.map((m) => `"${m}"`).join("; ")}`, c.prompt].filter(Boolean).join("\n");
  });
  return "EARLIER CANDIDATES AND WHAT WENT WRONG:\n\n" + parts.filter(Boolean).join("\n\n---\n\n");
}

const pool = [];
const add = (c) => {
  const text = c.prompt.trim();
  if (!text || knownTexts.has(text) || pool.some((x) => x.prompt === text)) return;
  pool.push({ ...c, prompt: text });
};
const tested = [];
for (const q of queue) {
  if (pool.length >= cfg.search.pool) break;
  add({ prompt: fs.readFileSync(path.join(ROOT, q), "utf8"), idea: `Community submission ${path.basename(q)}`, source: q });
  tested.push(q);
}
for (const c of reusable(prev)) {
  if (pool.length >= cfg.search.pool) break;
  add(c);
}

let search, confirm;
let selected = null;
const runsCache = new Map(); // candidate -> { screen, full, confirm } runs

// ---- per-stage scoring ------------------------------------------------------------------------------

// Plain summaries as graded by the main judge (default) or another stored grading (e.g. "plainScreen").
const plainsOf = (set, key) => set.map((a) => ({ slug: a.slug, ...(key ? a[key] : a.plain[writer.name]) }));
const stageResult = (runs, plains) => {
  const score = measure(runs, plains);
  return {
    score,
    targets: { ...qualify(score, cfg.targets), reason: null },
    objective: objectiveScore(score, cfg.objectives),
  };
};
const withReason = (r) => ((r.targets.reason = reasonOf(r.targets)), r);
const keepRun = (r) => ({ slug: r.slug, words: r.words, dashes: r.dashes, covered: r.covered, unsupported: r.unsupported, unsupportedClaims: r.unsupportedClaims, style: r.style, styleIssues: r.styleIssues, summary: r.summary });
const articleRecord = (a) => ({ slug: a.slug, title: a.source.title, url: a.source.url, revision: a.source.revision, words: a.source.words, keyPointsModel: a.keyPointsModel, points: a.points, plain: { ...a.plain?.[writer.name], summary: a.plain?.[writer.name]?.summary } });

try {
  // ---- 2. search set ----
  if (!fits(`search set: ${cfg.articles.search} answer keys and plain summaries`, [...stages.keyPoints({ cfg: scfg, n: cfg.articles.search, words: 2400 }), ...stages.plain({ cfg: scfg, n: cfg.articles.search, words: 2400 })]))
    throw new BudgetExceeded("Not enough budget to prepare the search set");
  search = await prepareArticles(ctx, cfg.articles.search, existingSlugs());
  report.articles.search = search.map(articleRecord);
  const screenSet = search.slice(0, cfg.articles.screen);
  const restSet = search.slice(cfg.articles.screen);

  // Fill the pool from the drafter only if it's short. Missing targets never triggers more drafting.
  if (pool.length < cfg.search.pool && fits("drafting", stages.draft({ cfg }))) {
    try {
      const drafts = await tasks.draft({ golden: golden.text, n: cfg.search.pool - pool.length, criteria: cfg.targets, feedback: feedbackFrom(prev) });
      for (const d of drafts) add({ ...d, source: "drafter" });
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      log(`drafter failed: ${e.message}`);
      report.drafterError = e.message;
    }
  }

  // Content safety on the prompt text itself: flagged prompts never compete.
  for (const [i, c] of pool.entries()) {
    const cand = { n: i + 1, prompt: c.prompt, idea: c.idea || "", source: c.source || "reused", from: c.from || null, promptLength: c.prompt.length };
    if (c.prompt.length > cfg.promptMaxChars) cand.excluded = `Too long: ${c.prompt.length} characters (limit ${cfg.promptMaxChars}).`;
    else {
      const flagged = await tasks.moderate(c.prompt).catch(() => null);
      cand.moderation = flagged === null ? "error" : flagged ? "flagged" : "clean";
      if (flagged !== false) cand.excluded = `Moderation ${cand.moderation}.`;
    }
    report.candidates.push(cand);
  }
  const live = report.candidates.filter((c) => !c.excluded);
  log(`pool: ${live.length} candidates (${report.candidates.length - live.length} excluded)`);

  // ---- 3. screen ----
  // Plain summaries re-graded by the screen judge, so style vs plain compares like with like.
  const screenPlain = await rejudge(ctx, screenSet, plainsOf(screenSet), writer.screenJudge);
  screenSet.forEach((a, i) => (a.plainScreen = screenPlain[i]));
  for (const c of live) {
    if (!fits(`screen candidate ${c.n}`, stages.run({ cfg: scfg, n: screenSet.length, words: words(screenSet), promptTokens: Math.ceil(c.promptLength / 4), screen: true }))) break;
    try {
      const runs = await runPrompt(ctx, c.prompt, screenSet, { judge: { ...writer.screenJudge, role: "screenJudge" } });
      runsCache.set(c, { screen: runs });
      const r = withReason(stageResult(runs, plainsOf(screenSet, "plainScreen")));
      const ranking = qualify(r.score, cfg.screening);
      c.screen = { judge: writer.screenJudge.model, ...r, ranking: { passed: ranking.passed, distance: ranking.distance, margins: ranking.margins, reason: reasonOf(ranking) }, runs: runs.map(keepRun) };
      log(`#${c.n} screen: ${reasonOf(ranking)}`);
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      c.error = e.message;
      log(`#${c.n} error: ${e.message}`);
    }
  }

  // ---- 4. finalists ----
  const sortable = (c, stage, result) => ({ n: c.n, promptLength: c.promptLength, result, objective: c[stage].objective, c });
  const screened = live.filter((c) => c.screen).map((c) => sortable(c, "screen", { passed: c.screen.ranking.passed, distance: c.screen.ranking.distance })).sort(rank);
  screened.forEach((x, i) => (x.c.screenRank = i + 1));
  const finalists = screened.slice(0, cfg.search.finalists).map((x) => x.c);

  const confirmPlan = () => [...stages.keyPoints({ cfg: scfg, n: cfg.articles.confirm, words: 2400 }), ...stages.plain({ cfg: scfg, n: cfg.articles.confirm, words: 2400 })];
  async function runConfirm(c) {
    if (!confirm) {
      if (!fits(`unseen set: ${cfg.articles.confirm} answer keys and plain summaries`, confirmPlan())) return false;
      confirm = await prepareArticles(ctx, cfg.articles.confirm, existingSlugs());
      report.articles.confirm = confirm.map(articleRecord);
    }
    if (!fits(`confirm candidate ${c.n}`, stages.run({ cfg: scfg, n: confirm.length, words: words(confirm), promptTokens: Math.ceil(c.promptLength / 4) }))) return false;
    const runs = await runPrompt(ctx, c.prompt, confirm);
    runsCache.get(c).confirm = runs;
    c.confirm = { judge: writer.judge.model, ...withReason(stageResult(runs, plainsOf(confirm))), runs: runs.map(keepRun) };
    log(`#${c.n} unseen articles: ${c.confirm.targets.reason}`);
    return true;
  }

  for (const c of finalists) {
    if (!fits(`full run, candidate ${c.n}`, [...stages.rejudge({ cfg: scfg, n: screenSet.length, words: words(screenSet) }), ...stages.run({ cfg: scfg, n: restSet.length, words: words(restSet), promptTokens: Math.ceil(c.promptLength / 4) })])) break;
    try {
      const again = await rejudge(ctx, screenSet, runsCache.get(c).screen, writer.judge);
      const rest = await runPrompt(ctx, c.prompt, restSet);
      const runs = [...again, ...rest];
      runsCache.get(c).full = runs;
      c.full = { judge: writer.judge.model, ...withReason(stageResult(runs, plainsOf(search))), runs: runs.map(keepRun) };
      log(`#${c.n} full: ${c.full.targets.reason}`);
      // First to meet every target on the search set and on unseen articles wins outright.
      if (c.full.targets.passed && (await runConfirm(c)) && c.confirm.targets.passed) {
        selected = c;
        c.selectedBecause = "first finalist to meet every target on the search set and on unseen articles";
        break;
      }
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      c.error = e.message;
      log(`#${c.n} error: ${e.message}`);
    }
  }

  // ---- 5. nobody met every target: the best measured candidate goes forward ----
  if (!selected) {
    const stageOf = (c) => (c.confirm ? "confirm" : c.full ? "full" : "screen");
    const best = live
      .filter((c) => c.screen)
      .map((c) => {
        const st = c[stageOf(c)];
        const t = stageOf(c) === "screen" ? qualify(st.score, cfg.targets) : st.targets;
        return sortable(c, stageOf(c), { passed: t.passed, distance: t.distance });
      })
      // Measured by the main judge beats screened only: rank full/confirm results ahead of screen ones.
      .sort((a, b) => Number(!!b.c.full) - Number(!!a.c.full) || rank(a, b))[0];
    if (best) {
      selected = best.c;
      selected.selectedBecause = "no candidate met every target; best by the deterministic ranking";
      if (!selected.confirm && selected.full) await runConfirm(selected).catch((e) => { if (!(e instanceof BudgetExceeded)) throw e; });
    }
  }
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  report.budgetNote = e.message;
  log(e.message);
}

// ---- 6. challenger, fight card, publication, quiz content ----------------------------------------

const runsBySlug = (runs) => Object.fromEntries((runs || []).map((r) => [r.slug, r]));
function writeArticles(articles, promptRuns) {
  report.contentSlugs = articles.map((a) => a.slug);
  for (const a of articles) {
    const dir = `content/articles/${a.slug}`;
    writeJSON(`${dir}/source.json`, a.source);
    writeJSON(`${dir}/points.json`, { points: a.points, key: a.key, question: a.question, keyPointsModel: a.keyPointsModel });
    if (a.plain?.[writer.name]) writeJSON(`${dir}/baseline.json`, a.plain[writer.name]);
    for (const [id, runs] of Object.entries(promptRuns)) if (runs[a.slug]) writeJSON(`${dir}/${model}/${id}.json`, runs[a.slug]);
  }
}
const upToBudget = (p, fallback) => p.catch((e) => { if (e instanceof BudgetExceeded) { log(`cut short: ${e.message}`); report.skipped.push({ label: "cut short", note: e.message }); return fallback(); } throw e; });

let autoMerge = true;
if (selected) {
  const id = nextPromptId(model);
  selected.selected = true;
  report.outcome = "challenger";
  const final = selected.confirm || selected.full || selected.screen;
  report.challenger = {
    id,
    candidate: selected.n,
    prompt: selected.prompt,
    idea: selected.idea,
    source: selected.source,
    from: selected.from,
    selectedBecause: selected.selectedBecause,
    measuredOn: selected.confirm ? "unseen articles" : selected.full ? "search set" : "screening articles only",
    metAllTargets: final.targets.passed,
    targets: final.targets,
    score: final.score,
  };
  writeText(`prompts/${model}/${id}.md`, selected.prompt);
  writeJSON(`prompts/${model}/active.json`, [id]);
  const decideOn = new Date(Date.parse(date) + 7 * 864e5).toISOString().slice(0, 10);
  writeJSON(`prompts/${model}/trial.json`, { challenger: id, started: date, decideOn, writer: writer.name, source: reportPath });

  // Golden on the same unseen articles, for the fight card only.
  let goldenConfirm = null;
  if (confirm && fits("golden on the unseen set (fight card only)", stages.run({ cfg: scfg, n: confirm.length, words: words(confirm), promptTokens: Math.ceil(golden.text.length / 4) }))) {
    goldenConfirm = await upToBudget(runPrompt(ctx, golden.text, confirm), () => null);
    if (goldenConfirm) report.golden.confirm = { judge: writer.judge.model, ...withReason(stageResult(goldenConfirm, plainsOf(confirm))), runs: goldenConfirm.map(keepRun), forFightCardOnly: true };
  }
  report.fightCard = {
    articles: confirm ? confirm.length : 0,
    writer: writer.name,
    judge: writer.judge.model,
    golden: report.golden.confirm ? { score: report.golden.confirm.score, targets: report.golden.confirm.targets } : null,
    challenger: selected.confirm ? { score: selected.confirm.score, targets: selected.confirm.targets } : null,
  };

  // Quiz content: the unseen articles (both prompts already written and graded) plus quiz-only ones.
  const challengerConfirm = runsCache.get(selected)?.confirm;
  let quiz = [];
  let gRuns = [];
  let cRuns = [];
  if (confirm && goldenConfirm && challengerConfirm) {
    quiz = [...confirm];
    gRuns = [...goldenConfirm];
    cRuns = [...challengerConfirm];
  }
  const extra = Math.max(0, cfg.articles.quiz - quiz.length);
  if (extra && fits(`quiz: ${extra} more articles`, stages.quiz({ cfg: scfg, n: extra, words: 2400, promptTokens: 300 }))) {
    await upToBudget(
      (async () => {
        const more = await prepareArticles(ctx, extra, existingSlugs(), { baseline: false });
        const [g, c] = await Promise.all([runPrompt(ctx, golden.text, more, { judge: false }), runPrompt(ctx, selected.prompt, more, { judge: false })]);
        quiz = [...quiz, ...more];
        gRuns = [...gRuns, ...g];
        cRuns = [...cRuns, ...c];
      })(),
      () => null
    );
  }
  const pub = await upToBudget(publicationChecks(ctx, quiz, [{ promptId: golden.id, runs: gRuns }, { promptId: id, runs: cRuns }]), () => ({ passing: [], results: [], skipped: true }));
  report.publication = { rules: cfg.publication, checker: pub.checker?.model, results: pub.results, published: pub.passing.map((a) => a.slug) };
  const asked = await upToBudget(addQuestions(ctx, pub.passing, [gRuns, cRuns]), () => pub.passing.filter((a) => a.question));
  writeArticles(asked, { [golden.id]: runsBySlug(gRuns), [id]: runsBySlug(cRuns) });
  if (asked.length < 5) {
    autoMerge = false; // too little quiz content to run a trial on: leave it for a human
    report.warning = `Only ${asked.length} quiz articles passed the publication checks and got a question.`;
  }
} else {
  writeJSON(`prompts/${model}/active.json`, []);
}

// Closest unpicked candidates get a loser file (new ones only: reused prompts have one already).
const ordered = report.candidates.filter((c) => !c.selected && !c.excluded && c.screen && !c.from).sort((a, b) => (a.screenRank ?? 99) - (b.screenRank ?? 99)).slice(0, 3);
let nextId = Number(nextPromptId(model).slice(2));
for (const c of ordered) {
  const st = c.full || c.screen;
  c.loserId = "p-" + String(nextId++).padStart(4, "0");
  const t = st.targets;
  const table = `| Measured on | Key points kept | Shorter than plain | Unsupported | Em dashes | AI-style (plain) |\n|---|---|---|---|---|---|\n| ${st.score.n} articles (${c.full ? "full" : "screen"}) | ${pct(st.score.coverage)} | ${pct(st.score.compression)} | ${st.score.unsupported} | ${st.score.dashes} | ${st.score.style} (${st.score.plainStyle ?? "n/a"}) |`;
  writeLoser(model, { id: c.loserId, date, by: c.source?.startsWith("prompts/queue/") ? path.basename(c.source, ".md").match(QUEUE_NAME)?.[1] : null, stage: `eval (${c.full ? "full" : "screen"})`, reason: `Not picked. ${t.reason || reasonOf(t)}`, table, prompt: c.prompt, report: reportPath, models: { writer: writer.model, judge: c.full ? writer.judge.model : writer.screenJudge.model } });
}
for (const q of tested) fs.rmSync(path.join(ROOT, q), { force: true });

report.usd = Math.round(budget.usd * 1000) / 1000;
report.byModel = budget.byModel;
report.byRole = budget.byRole;
report.autoMerge = autoMerge;
writeJSON(reportPath, report);

// ---- 7. PR text ---------------------------------------------------------------------------------------

const fmtMargin = (key, m) => {
  if (!m || m.margin === null) return "n/a";
  const isShare = key === "keyPointCoverage" || key === "compression";
  const have = isShare ? pct(m.have) : m.have;
  const need = isShare ? pct(m.need) : m.need;
  const gap = isShare ? `${m.margin >= 0 ? "+" : ""}${(m.margin * 100).toFixed(1)} pts` : `${m.margin >= 0 ? "+" : ""}${m.margin}`;
  return `${m.margin >= 0 ? "✓" : "✗"} ${have} (target ${key === "keyPointCoverage" || key === "compression" ? "≥" : "≤"} ${need}, ${gap})`;
};
const LABEL = { keyPointCoverage: "Key points kept", compression: "Shorter than plain", unsupported: "Unsupported claims", emDashes: "Em dashes", style: "AI-style phrases" };
const targetsTable = (t) => Object.entries(t.margins).map(([k, m]) => `| ${LABEL[k] || k} | ${fmtMargin(k, m)} |`).join("\n");

const title = selected
  ? `Weekly eval ${date}: challenger prompt ${promptName(report.challenger.id)}${report.challenger.metAllTargets ? "" : " (misses some targets)"}`
  : `Weekly eval ${date}: no challenger (no candidates)`;
const decisionFile = path.join(ROOT, ".cache/decision.json");
const decision = fs.existsSync(decisionFile) ? JSON.parse(fs.readFileSync(decisionFile, "utf8")) : null;
const fullTitle = decision && decision.outcome !== "none" ? `${decision.title}. ${title}` : title;

let body = decision?.body ? decision.body + "\n" : "";
body += `## ${title}\n\n`;
body += `Writer this week: **${writer.name}** (\`${writer.model}\`${writer.effort ? `, effort ${writer.effort}` : ""}), picked ${cfg.writerPick.method}${cfg.writerPick.seed ? ` from "${cfg.writerPick.seed}"` : ""}. Judged by \`${writer.judge.model}\` (screening: \`${writer.screenJudge.model}\`), answer keys by \`${writer.keyPoints.model}\`.\n\n`;
if (selected) {
  const c = report.challenger;
  body += `**Why this one:** ${c.selectedBecause}. Measured on ${c.measuredOn}.\n\n`;
  body += `| Target | Result |\n|---|---|\n${targetsTable(c.targets)}\n\n`;
  if (!c.metAllTargets) body += `Missed: ${c.targets.reason}\n\n`;
  body += "Readers decide whether it replaces golden. Promotion is never automatic: a win needs a maintainer to merge.\n\n";
  body += "### Challenger prompt\n\n```text\n" + c.prompt + "\n```\n\n";
  if (report.fightCard?.golden) body += `Golden on the same unseen articles (fight card only, not used to pick): ${report.fightCard.golden.targets.reason || reasonOf(report.fightCard.golden.targets)}\n\n`;
  body += `Publication checks: ${report.publication.published.length} of ${report.publication.results.length} quiz articles passed (checked by \`${report.publication.checker}\`). ${report.warning || ""}\n\n`;
}
body += `### Candidates\n\n| # | Source | Screen rank | Screen: kept / shorter / unsupported | Full: kept / shorter / unsupported |\n|---|---|---|---|---|\n`;
for (const c of report.candidates) {
  const s = c.screen?.score;
  const f = c.full?.score;
  const cell = (x) => (x ? `${pct(x.coverage)} / ${pct(x.compression)} / ${x.unsupported}` : "–");
  body += `| ${c.n}${c.selected ? " ★" : ""} | ${c.source === "reused" ? `reused from ${c.from?.report}` : c.source} | ${c.excluded ? c.excluded : c.screenRank ?? "–"} | ${cell(s)} | ${cell(f)} |\n`;
}
body += `\nTargets: ${describeCriteria(cfg.targets).replace(/\n/g, "; ")}.\n\n`;
if (report.skipped.length) body += `Skipped to stay in budget: ${report.skipped.map((s) => s.label).join("; ")}.\n\n`;
body += `Cost: $${budget.usd.toFixed(2)} of $${cfg.budget.maxUsd.toFixed(2)} (${spendLine(budget)}). Full log: \`${reportPath}\`.\n`;

const cacheDir = path.join(ROOT, ".cache");
fs.mkdirSync(cacheDir, { recursive: true });
const bodyPath = path.join(cacheDir, "pr-body.md");
fs.writeFileSync(bodyPath, body);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, [`date=${date}`, `title=${fullTitle}`, `body_path=${bodyPath}`, `outcome=${report.outcome}`, `auto_merge=${autoMerge}`].join("\n") + "\n");
}
log(`${fullTitle}. Spent $${budget.usd.toFixed(2)}.`);
