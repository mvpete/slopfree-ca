// Weekly search: find a challenger that beats the golden prompt, or log why none did.
//
//   node scripts/weekly-topics.js            real run (needs OPENAI_API_KEY and ANTHROPIC_API_KEY)
//   DRY_RUN=1 ARTICLES=6 SCREEN_ARTICLES=2 CANDIDATES=3 SLOPFREE_ROOT=/tmp/x node scripts/weekly-topics.js
//
// One batch a week, so the cost is fixed (about $1.40, hard stop at cfg.maxUsdPerRun):
//   1. 10 articles: key points, plain baseline, golden. Golden vs plain is the health check.
//   2. The drafter writes cfg.candidates prompts in one call (community submissions go first).
//   3. Screen every candidate on 3 articles against golden, graded by the cheap screen judge.
//   4. The best cfg.finalists go on: all 10 articles, then 10 fresh ones, graded by the main judge.
// Challengers are compared with golden, not with the plain summary: the question is whether it
// beats what we ship.
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./lib/config.js";
import { createContext, prepareArticles, runPrompt, rejudge, scoreRuns, addQuestions, BudgetExceeded } from "./lib/eval.js";
import { readGolden, nextPromptId, existingSlugs, writeJSON, writeText, writeLoser } from "./lib/store.js";
import { reasonOf } from "./lib/gate.js";
import { spendLine } from "./lib/llm.js";
import { today, pct, promptName, QUEUE_NAME } from "./lib/util.js";

const cfg = loadConfig();
const ctx = createContext(cfg);
const { tasks, log } = ctx;
const model = cfg.model;
const date = today();
const reportPath = `evals/${date}.json`;

const golden = readGolden(model);
log(`golden ${golden.id}; writer ${cfg.writerModel}; judge ${cfg.judgeModel}; screen judge ${cfg.screenJudgeModel}; drafter ${cfg.drafterModel}${cfg.dryRun ? " (dry run)" : ""}`);

const report = {
  date,
  model,
  writerModel: cfg.writerModel,
  judgeModel: cfg.judgeModel,
  screenJudgeModel: cfg.screenJudgeModel,
  drafterModel: cfg.drafterModel,
  wrapper: cfg.wrapper,
  gate: cfg.gate,
  health: cfg.health,
  golden: { id: golden.id },
  attempts: [],
  outcome: "none",
};

const exclude = existingSlugs();
const queueDir = path.join(ROOT, "prompts/queue");
const queue = fs.existsSync(queueDir)
  ? fs
      .readdirSync(queueDir)
      .map((f) => ({ f, m: f.match(QUEUE_NAME) }))
      .filter((x) => x.m)
      // Oldest submission first (one per person per day).
      .sort((a, b) => a.m[2].localeCompare(b.m[2]) || a.f.localeCompare(b.f))
      .map((x) => `prompts/queue/${x.f}`)
  : [];

// Last week's losers, so the drafter doesn't repeat them.
function earlierLosers() {
  const dir = path.join(ROOT, "evals");
  if (!fs.existsSync(dir)) return [];
  const last = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f < `${date}.json`).sort().pop();
  if (!last) return [];
  const r = JSON.parse(fs.readFileSync(path.join(dir, last), "utf8"));
  return (r.attempts || []).filter((a) => a.prompt && a.reason && !a.passed);
}

const tested = [];
const runsOf = new Map(); // attempt -> its screen runs, kept out of the report
let search, confirm, goldenConfirm;
let winner = null;

try {
  // 1. Search set: key points and the plain baseline, graded by the main judge.
  search = await prepareArticles(ctx, cfg.articles, exclude);
  const goldenRuns = await runPrompt(ctx, golden.text, search);
  search.goldenRuns = goldenRuns;

  // Health check: golden against the plain summary. Failing opens an issue; it doesn't stop the search.
  const h = scoreRuns(cfg, search, goldenRuns, { gate: cfg.health });
  report.golden = { id: golden.id, score: h.score, passed: h.gate.passed, reason: reasonOf(h.gate), stats: h.stats };
  log(`golden vs plain: ${h.gate.passed ? "healthy" : "UNHEALTHY"}. ${reasonOf(h.gate)}`);

  const screenSet = search.slice(0, cfg.screenArticles);
  const restSet = search.slice(cfg.screenArticles);
  // Screen scores compare like with like: golden is re-graded by the screen judge too.
  const goldenScreen = await rejudge(ctx, screenSet, goldenRuns.slice(0, screenSet.length), cfg.screenJudgeModel);

  // 2. This week's batch: submissions first, the drafter fills the rest.
  const subs = queue.splice(0, cfg.candidates);
  const batch = subs.map((q) => ({ source: q, prompt: fs.readFileSync(path.join(ROOT, q), "utf8").trim(), idea: `Community submission ${path.basename(q)}` }));
  tested.push(...subs);
  const want = cfg.candidates - batch.length;
  if (want > 0) {
    try {
      batch.push(...(await tasks.draft(golden.text, earlierLosers(), report.golden.reason, want)));
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      log(`drafter failed: ${e.message}`);
    }
  }

  // 3. Screen.
  for (const [i, c] of batch.entries()) {
    const attempt = { n: i + 1, stage: "screen", passed: false, prompt: c.prompt, idea: c.idea };
    if (c.source) attempt.source = c.source;
    report.attempts.push(attempt);
    if (c.prompt.length > cfg.promptMaxChars) {
      attempt.stage = "draft";
      attempt.reason = `Too long: ${c.prompt.length} characters (limit ${cfg.promptMaxChars}).`;
      continue;
    }
    try {
      const runs = await runPrompt(ctx, c.prompt, screenSet, { judgeModel: cfg.screenJudgeModel });
      const r = scoreRuns(cfg, screenSet, runs, { ref: goldenScreen });
      Object.assign(attempt, { score: r.score, distance: r.gate.distance, reason: reasonOf(r.gate), screenPassed: r.gate.passed });
      runsOf.set(attempt, runs);
      log(`#${attempt.n} screen: ${r.gate.passed ? "pass" : attempt.reason}`);
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      attempt.reason = `Error: ${e.message}`;
      log(`#${attempt.n} error: ${e.message}`);
    }
  }

  // 4. Finalists: best screen scores first.
  const finalists = report.attempts
    .filter((a) => a.screenPassed)
    .sort((a, b) => b.score.composite - a.score.composite)
    .slice(0, cfg.finalists);

  for (const attempt of finalists) {
    try {
      attempt.stage = "full";
      const screenMain = await rejudge(ctx, screenSet, runsOf.get(attempt), cfg.judgeModel);
      const fullRuns = [...screenMain, ...(await runPrompt(ctx, attempt.prompt, restSet))];
      let r = scoreRuns(cfg, search, fullRuns, { ref: goldenRuns });
      Object.assign(attempt, { score: r.score, distance: r.gate.distance, reason: reasonOf(r.gate) });
      if (!r.gate.passed) { log(`#${attempt.n} full: ${attempt.reason}`); continue; }
      const searchResult = { score: r.score, stats: r.stats };

      attempt.stage = "confirm";
      if (!confirm) {
        confirm = await prepareArticles(ctx, cfg.articles, exclude, { baseline: false, points: true });
        goldenConfirm = await runPrompt(ctx, golden.text, confirm);
      }
      const confirmRuns = await runPrompt(ctx, attempt.prompt, confirm);
      r = scoreRuns(cfg, confirm, confirmRuns, { ref: goldenConfirm });
      Object.assign(attempt, { score: r.score, distance: r.gate.distance, reason: reasonOf(r.gate) });
      if (!r.gate.passed) { log(`#${attempt.n} confirm: ${attempt.reason}`); continue; }

      attempt.passed = true;
      attempt.reason = "Beat golden on the search set and on fresh articles.";
      winner = { prompt: attempt.prompt, idea: attempt.idea, attempt: attempt.n, search: searchResult, confirm: { score: r.score, stats: r.stats }, confirmRuns };
      log(`#${attempt.n} PASSED`);
      break;
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      attempt.reason = `Error: ${e.message}`;
      log(`#${attempt.n} error: ${e.message}`);
    }
  }
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  report.outcome = "budget";
  report.budgetNote = e.message;
  log(e.message);
}
for (const a of report.attempts) delete a.screenPassed;

// 5. Write results.
const runsBySlug = (runs) => Object.fromEntries((runs || []).map((r) => [r.slug, r]));

function writeArticles(articles, promptRuns) {
  report.contentSlugs = articles.map((a) => a.slug); // what the quiz serves this week
  for (const a of articles) {
    const dir = `content/articles/${a.slug}`;
    writeJSON(`${dir}/source.json`, a.source);
    writeJSON(`${dir}/points.json`, { points: a.points, key: a.key, question: a.question });
    if (a.baseline) writeJSON(`${dir}/baseline.json`, a.baseline);
    for (const [id, runs] of Object.entries(promptRuns)) {
      const r = runs[a.slug];
      if (r) writeJSON(`${dir}/${model}/${id}.json`, r);
    }
  }
}

// Quiz extras and questions are cheap, but they still stop at the budget.
const upToBudget = (p, fallback) => p.catch((e) => { if (e instanceof BudgetExceeded) { log(`cut short: ${e.message}`); return fallback(); } throw e; });

let autoMerge = true;
if (winner) {
  const id = nextPromptId(model);
  report.outcome = "challenger";
  const flagged = await tasks.moderate(winner.prompt).catch(() => null);
  if (flagged !== false) autoMerge = false; // flagged, or the check itself failed: leave it for a human
  report.challenger = { id, prompt: winner.prompt, idea: winner.idea, attempt: winner.attempt, moderation: flagged === null ? "error" : flagged ? "flagged" : "clean", search: winner.search, confirm: winner.confirm };
  writeText(`prompts/${model}/${id}.md`, winner.prompt);
  writeJSON(`prompts/${model}/active.json`, [id]);
  const decideOn = new Date(Date.parse(date) + 7 * 864e5).toISOString().slice(0, 10);
  writeJSON(`prompts/${model}/trial.json`, { challenger: id, started: date, decideOn });

  // Quiz content: each reader should see an article only once, so publish enough for a week of answers.
  let quiz = confirm;
  let goldenQuiz = goldenConfirm;
  let challengerQuiz = winner.confirmRuns;
  const extra = Math.max(0, cfg.quizArticles - confirm.length);
  if (extra) {
    await upToBudget(
      (async () => {
        // Quiz-only articles: just the two summaries. No key points, baseline or grading.
        const more = await prepareArticles(ctx, extra, exclude, { baseline: false });
        const [g, c] = await Promise.all([runPrompt(ctx, golden.text, more, { judge: false }), runPrompt(ctx, winner.prompt, more, { judge: false })]);
        quiz = [...confirm, ...more];
        goldenQuiz = [...goldenConfirm, ...g];
        challengerQuiz = [...winner.confirmRuns, ...c];
      })(),
      () => null
    );
  }
  const quizOk = await upToBudget(addQuestions(ctx, quiz, [goldenQuiz, challengerQuiz]), () => quiz.filter((a) => a.question));
  writeArticles(quizOk, { [golden.id]: runsBySlug(goldenQuiz), [id]: runsBySlug(challengerQuiz) });
} else {
  writeJSON(`prompts/${model}/active.json`, []);
  if (search?.goldenRuns) {
    const ok = await upToBudget(addQuestions(ctx, search, [search.goldenRuns]), () => search.filter((a) => a.question));
    writeArticles(ok, { [golden.id]: runsBySlug(search.goldenRuns) });
  }
}

// Three closest misses get a loser file.
const misses = report.attempts
  .filter((a) => !a.passed && a.prompt)
  .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
  .slice(0, 3);
let nextId = Number(nextPromptId(model).slice(2));
for (const m of misses) {
  m.loserId = "p-" + String(nextId++).padStart(4, "0"); // file name; shown to people as promptName()
  writeLoser(model, { id: m.loserId, date, by: m.source ? path.basename(m.source, ".md").match(QUEUE_NAME)?.[1] : null, stage: `eval (${m.stage})`, reason: m.reason, score: m.score, prompt: m.prompt, report: reportPath, models: { writer: cfg.writerModel, judge: m.stage === "screen" ? cfg.screenJudgeModel : cfg.judgeModel } });
}

// Tested submissions leave the queue; their result is in the report (and a loser file if close).
for (const q of tested) fs.rmSync(path.join(ROOT, q), { force: true });

report.tokensUsed = ctx.budget.used;
report.tokensByModel = ctx.budget.byModel;
report.usd = Math.round(ctx.budget.usd * 100) / 100;
report.autoMerge = autoMerge;
writeJSON(reportPath, report);

// 6. PR text and workflow outputs.
const stageCounts = report.attempts.reduce((acc, a) => ((acc[a.passed ? "passed" : a.stage] = (acc[a.passed ? "passed" : a.stage] || 0) + 1), acc), {});
const x = (v) => (Number.isFinite(v) ? v.toFixed(2) + "×" : "n/a");
const row = (label, sc) => (sc ? `| ${label} | ${sc.n} | ${pct(sc.coverage)} | ${x(sc.composite)} | ${pct(sc.lengthRatio)} | ${sc.candUnsupported} / ${sc.baseUnsupported} | ${sc.candDashes} | ${sc.candStyle} / ${sc.baseStyle} |` : "");
const title = winner
  ? `Weekly eval ${date}: new challenger, prompt ${promptName(report.challenger.id)}`
  : `Weekly eval ${date}: no challenger${report.outcome === "budget" ? " (budget spent)" : ""}`;

// golden-pull.js runs first in the same job; its decision leads the PR.
const decisionFile = path.join(ROOT, ".cache/decision.json");
const decision = fs.existsSync(decisionFile) ? JSON.parse(fs.readFileSync(decisionFile, "utf8")) : null;
const fullTitle = decision && decision.outcome !== "none" ? `${decision.title}. ${title}` : title;

let body = decision?.body ? decision.body + "\n" : "";
body += `## ${title}\n\n`;
body += `Summaries by \`${cfg.writerModel}\`. Key points and final grading by \`${cfg.judgeModel}\`, screening by \`${cfg.screenJudgeModel}\`. Candidates drafted by \`${cfg.drafterModel}\`.\n\n`;
body += `Golden prompt **${promptName(golden.id)}** is ${report.golden.passed ? "healthy" : "**unhealthy**"} against the plain summary. ${report.golden.reason || ""}\n\n`;
body += `| Set | Articles | Key points vs reference | Net key points per word vs reference | Length vs reference | Unsupported (prompt / ref) | Em dashes | AI-style phrases (prompt / ref) |\n|---|---|---|---|---|---|---|---|\n`;
body += row(`Golden vs plain summary`, report.golden.score) + "\n";
if (winner) {
  body += row(`Challenger vs golden, search set`, winner.search.score) + "\n" + row(`Challenger vs golden, fresh articles`, winner.confirm.score) + "\n\n";
  body += `Candidate ${winner.attempt} of ${report.attempts.length}. Idea: ${winner.idea || "n/a"}\n\nModeration: ${report.challenger.moderation}. Auto-merge: ${autoMerge ? "yes" : "no, needs review"}.\n\n`;
  body += "### Challenger prompt\n\n```text\n" + winner.prompt + "\n```\n\n";
  const a = confirm[0];
  const g = runsBySlug(goldenConfirm)[a.slug];
  const c = runsBySlug(winner.confirmRuns)[a.slug];
  body += `### Sample: [${a.source.title}](${a.source.url})\n\n**Golden (${g.words} words)**\n\n> ${g.summary.replace(/\n+/g, "\n> ")}\n\n**Challenger (${c.words} words)**\n\n> ${c.summary.replace(/\n+/g, "\n> ")}\n\n`;
} else body += "\n";
body += `### Candidates\n\n${report.attempts.map((a) => `- ${a.n}${a.source ? ` (${path.basename(a.source, ".md")})` : ""}, ${a.passed ? "passed" : `stopped at ${a.stage}`}: ${a.reason || ""}`).join("\n") || "- none"}\n\n`;
if (misses.length) body += `### Close but no cigar\n\n${misses.map((m) => `- Prompt ${promptName(m.loserId)}${m.source ? ` (${path.basename(m.source, ".md")})` : ""}: ${m.reason}`).join("\n")}\n\n`;
body += `Cost: $${ctx.budget.usd.toFixed(2)} of $${cfg.maxUsdPerRun.toFixed(2)} (${spendLine(ctx.budget)}). Full log: \`${reportPath}\`.\n`;

const cacheDir = path.join(ROOT, ".cache");
fs.mkdirSync(cacheDir, { recursive: true });
const bodyPath = path.join(cacheDir, "pr-body.md");
fs.writeFileSync(bodyPath, body);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    [`date=${date}`, `title=${fullTitle}`, `body_path=${bodyPath}`, `outcome=${report.outcome}`, `auto_merge=${autoMerge}`, `golden_passed=${report.golden.passed === true}`].join("\n") + "\n"
  );
}
log(`${fullTitle}. Spent $${ctx.budget.usd.toFixed(2)}.`);
