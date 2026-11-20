// Weekly search: find a challenger that beats the plain-summary baseline, or log why none did.
//
//   node scripts/weekly-topics.js            real run (needs OPENAI_API_KEY)
//   DRY_RUN=1 ARTICLES=6 SCREEN_ARTICLES=2 MAX_ATTEMPTS=5 SLOPFREE_ROOT=/tmp/x node scripts/weekly-topics.js
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./lib/config.js";
import { createContext, prepareArticles, runPrompt, scoreRuns, addQuestions, BudgetExceeded } from "./lib/eval.js";
import { readGolden, nextPromptId, existingSlugs, writeJSON, writeText, writeLoser } from "./lib/store.js";
import { reasonOf } from "./lib/gate.js";
import { today, pct, promptName, QUEUE_NAME } from "./lib/util.js";

const cfg = loadConfig();
const ctx = createContext(cfg);
const { tasks, log } = ctx;
const model = cfg.model;
const date = today();
const reportPath = `evals/${date}.json`;

const golden = readGolden(model);
log(`golden ${golden.id}; writer ${cfg.writerModel}; judge ${cfg.judgeModel}${cfg.dryRun ? " (dry run)" : ""}`);

const report = {
  date,
  model,
  writerModel: cfg.writerModel,
  judgeModel: cfg.judgeModel,
  drafterModel: cfg.drafterModel,
  wrapper: cfg.wrapper,
  gate: cfg.gate,
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
      // Oldest submission first; several from one person on one day keep their -2, -3 order.
      .sort((a, b) => a.m[2].localeCompare(b.m[2]) || Number(a.m[3] || 1) - Number(b.m[3] || 1) || a.f.localeCompare(b.f))
      .map((x) => `prompts/queue/${x.f}`)
  : [];
const tested = [];
let search, confirm, goldenConfirm;
let winner = null;

try {
  // 1. Search set: articles with every point listed and a baseline.
  search = await prepareArticles(ctx, cfg.articles, exclude);

  // 2. Golden must keep passing.
  const goldenRuns = await runPrompt(ctx, golden.text, search);
  const g = scoreRuns(cfg, search, goldenRuns);
  report.golden = { id: golden.id, score: g.score, passed: g.gate.passed, reason: reasonOf(g.gate), stats: g.stats };
  search.goldenRuns = goldenRuns;
  log(`golden ${g.gate.passed ? "passes" : "FAILS"}: ${reasonOf(g.gate)}`);

  // 3. Search loop.
  const screenSet = search.slice(0, cfg.screenArticles);
  const restSet = search.slice(cfg.screenArticles);

  for (let n = 1; n <= cfg.maxAttempts; n++) {
    const attempt = { n, stage: "draft", passed: false };
    report.attempts.push(attempt);
    try {
      // Community submissions first, then AI drafts.
      const q = queue.shift();
      const d = q
        ? { prompt: fs.readFileSync(path.join(ROOT, q), "utf8").trim(), idea: `Community submission ${path.basename(q)}` }
        : await tasks.draft(golden.text, report.attempts.filter((a) => a.prompt), report.golden.reason);
      if (q) { attempt.source = q; tested.push(q); }
      attempt.prompt = d.prompt;
      attempt.idea = d.idea;
      if (d.prompt.length > cfg.promptMaxChars) {
        attempt.reason = `Too long: ${d.prompt.length} characters (limit ${cfg.promptMaxChars}).`;
        continue;
      }

      attempt.stage = "screen";
      const screenRuns = await runPrompt(ctx, d.prompt, screenSet);
      let r = scoreRuns(cfg, screenSet, screenRuns);
      Object.assign(attempt, { score: r.score, distance: r.gate.distance, reason: reasonOf(r.gate) });
      if (!r.gate.passed) { log(`#${n} screen: ${attempt.reason}`); continue; }

      attempt.stage = "full";
      const fullRuns = [...screenRuns, ...(await runPrompt(ctx, d.prompt, restSet))];
      r = scoreRuns(cfg, search, fullRuns);
      Object.assign(attempt, { score: r.score, distance: r.gate.distance, reason: reasonOf(r.gate) });
      if (!r.gate.passed) { log(`#${n} full: ${attempt.reason}`); continue; }
      const searchResult = { score: r.score, stats: r.stats };

      attempt.stage = "confirm";
      if (!confirm) {
        confirm = await prepareArticles(ctx, cfg.articles, exclude);
        goldenConfirm = await runPrompt(ctx, golden.text, confirm);
      }
      const confirmRuns = await runPrompt(ctx, d.prompt, confirm);
      r = scoreRuns(cfg, confirm, confirmRuns);
      Object.assign(attempt, { score: r.score, distance: r.gate.distance, reason: reasonOf(r.gate) });
      if (!r.gate.passed) { log(`#${n} confirm: ${attempt.reason}`); continue; }

      attempt.passed = true;
      attempt.reason = "Passed screen, full and confirm.";
      winner = { prompt: d.prompt, idea: d.idea, attempt: n, search: searchResult, confirm: { score: r.score, stats: r.stats }, confirmRuns };
      log(`#${n} PASSED`);
      break;
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      attempt.reason = `Error: ${e.message}`;
      log(`#${n} error: ${e.message}`);
    }
  }
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  report.outcome = "budget";
  report.budgetNote = e.message;
  log(e.message);
}

// 4. Write results.
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
    try {
      // Quiz-only articles: points and the two summaries are all the quiz needs. No baseline, no grading.
      const more = await prepareArticles(ctx, extra, exclude, { baseline: false });
      const [g, c] = await Promise.all([runPrompt(ctx, golden.text, more, { judge: false }), runPrompt(ctx, winner.prompt, more, { judge: false })]);
      quiz = [...confirm, ...more];
      goldenQuiz = [...goldenConfirm, ...g];
      challengerQuiz = [...winner.confirmRuns, ...c];
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e;
      log(`quiz articles cut short: ${e.message}`);
    }
  }
  const quizOk = await addQuestions(ctx, quiz, [goldenQuiz, challengerQuiz]).catch((e) => { if (e instanceof BudgetExceeded) return quiz.filter((a) => a.question); throw e; });
  writeArticles(quizOk, { [golden.id]: runsBySlug(goldenQuiz), [id]: runsBySlug(challengerQuiz) });
} else {
  writeJSON(`prompts/${model}/active.json`, []);
  if (search?.goldenRuns) {
    const ok = await addQuestions(ctx, search, [search.goldenRuns]).catch((e) => { if (e instanceof BudgetExceeded) return search.filter((a) => a.question); throw e; });
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
  writeLoser(model, { id: m.loserId, date, by: m.source ? path.basename(m.source, ".md").match(QUEUE_NAME)?.[1] : null, stage: `eval (${m.stage})`, reason: m.reason, score: m.score, prompt: m.prompt, report: reportPath, models: { writer: cfg.writerModel, judge: cfg.judgeModel } });
}

// Tested submissions leave the queue; their result is in the report (and a loser file if close).
for (const q of tested) fs.rmSync(path.join(ROOT, q), { force: true });

report.tokensUsed = ctx.budget.used;
report.tokensByModel = ctx.budget.byModel;
report.autoMerge = autoMerge;
writeJSON(reportPath, report);

// 5. PR text and workflow outputs.
const stageCounts = report.attempts.reduce((acc, a) => ((acc[a.passed ? "passed" : a.stage] = (acc[a.passed ? "passed" : a.stage] || 0) + 1), acc), {});
const row = (label, sc) => sc ? `| ${label} | ${sc.n} | ${pct(sc.coverage)} | ${pct(sc.floor)} | ${sc.density.toFixed(2)}× | ${sc.candUnsupported} / ${sc.baseUnsupported} | ${sc.candDashes} | ${sc.candStyle} / ${sc.baseStyle} |` : "";
const title = winner
  ? `Weekly eval ${date}: new challenger, prompt ${promptName(report.challenger.id)}`
  : `Weekly eval ${date}: no challenger${report.outcome === "budget" ? " (budget spent)" : ""}`;

// golden-pull.js runs first in the same job; its decision leads the PR.
const decisionFile = path.join(ROOT, ".cache/decision.json");
const decision = fs.existsSync(decisionFile) ? JSON.parse(fs.readFileSync(decisionFile, "utf8")) : null;
const fullTitle = decision && decision.outcome !== "none" ? `${decision.title}. ${title}` : title;

let body = decision?.body ? decision.body + "\n" : "";
body += `## ${title}\n\n`;
body += `Summaries by \`${cfg.writerModel}\`, judged by \`${cfg.judgeModel}\`, candidates drafted by \`${cfg.drafterModel}\`.\n\n`;
body += `Golden prompt **${promptName(golden.id)}** ${report.golden.passed ? "still passes" : "**fails**"} the gate. ${report.golden.reason || ""}\n\n`;
body += `| Set | Articles | Key points vs baseline | Worst article | Key points per word vs baseline | Unsupported (prompt / base) | Em dashes | AI-style phrases (prompt / base) |\n|---|---|---|---|---|---|---|---|\n`;
body += row(`Golden, search set`, report.golden.score) + "\n";
if (winner) {
  body += row(`Challenger, search set`, winner.search.score) + "\n" + row(`Challenger, fresh articles`, winner.confirm.score) + "\n\n";
  body += `Found on attempt ${winner.attempt} of ${cfg.maxAttempts}. Idea: ${winner.idea || "n/a"}\n\nModeration: ${report.challenger.moderation}. Auto-merge: ${autoMerge ? "yes" : "no, needs review"}.\n\n`;
  body += "### Challenger prompt\n\n```text\n" + winner.prompt + "\n```\n\n";
  const a = confirm[0];
  const c = runsBySlug(winner.confirmRuns)[a.slug];
  body += `### Sample: [${a.source.title}](${a.source.url})\n\n**Baseline (${a.baseline.words} words)**\n\n> ${a.baseline.summary.replace(/\n+/g, "\n> ")}\n\n**Challenger (${c.words} words)**\n\n> ${c.summary.replace(/\n+/g, "\n> ")}\n\n`;
} else body += "\n";
body += `### Attempts\n\n${Object.entries(stageCounts).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "- none"}\n\n`;
if (misses.length) body += `### Close but no cigar\n\n${misses.map((m) => `- Prompt ${promptName(m.loserId)}${m.source ? ` (${path.basename(m.source, ".md")})` : ""}: ${m.reason}`).join("\n")}\n\n`;
body += `Tokens used: ${ctx.budget.used.toLocaleString()} (${Object.entries(ctx.budget.byModel).map(([m, t]) => `${m}: ${t.input.toLocaleString()} in, ${t.output.toLocaleString()} out`).join("; ") || "none"}). Full log: \`${reportPath}\`.\n`;

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
log(fullTitle);
