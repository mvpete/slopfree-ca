// Weekly search: find a challenger that beats the plain-summary baseline, or log why none did.
//
//   node scripts/weekly-topics.js            real run (needs OPENAI_API_KEY)
//   DRY_RUN=1 ARTICLES=6 SCREEN_ARTICLES=2 MAX_ATTEMPTS=5 SLOPFREE_ROOT=/tmp/x node scripts/weekly-topics.js
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./lib/config.js";
import { createContext, prepareArticles, runPrompt, scoreRuns, BudgetExceeded } from "./lib/eval.js";
import { readGolden, nextPromptId, existingSlugs, writeJSON, writeText, writeLoser } from "./lib/store.js";
import { reasonOf } from "./lib/gate.js";
import { today, pct } from "./lib/util.js";

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
  wrapper: cfg.wrapper,
  gate: cfg.gate,
  golden: { id: golden.id },
  attempts: [],
  outcome: "none",
};

const exclude = existingSlugs();
const queueDir = path.join(ROOT, "prompts/queue");
const queue = fs.existsSync(queueDir)
  ? fs.readdirSync(queueDir).filter((f) => f.endsWith(".md") && f !== "README.md").sort().map((f) => `prompts/queue/${f}`)
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
        : await tasks.draft(golden.text, report.attempts.filter((a) => a.prompt));
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
    writeJSON(`${dir}/points.json`, { points: a.points, question: a.question });
    writeJSON(`${dir}/baseline.json`, a.baseline);
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

  // Quiz content: each reader should see an article only once, so publish enough for a week of answers.
  let quiz = confirm;
  let goldenQuiz = goldenConfirm;
  let challengerQuiz = winner.confirmRuns;
  const extra = Math.max(0, cfg.quizArticles - confirm.length);
  if (extra) {
    try {
      const more = await prepareArticles(ctx, extra, exclude);
      const [g, c] = await Promise.all([runPrompt(ctx, golden.text, more), runPrompt(ctx, winner.prompt, more)]);
      quiz = [...confirm, ...more];
      goldenQuiz = [...goldenConfirm, ...g];
      challengerQuiz = [...winner.confirmRuns, ...c];
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e;
      log(`quiz articles cut short: ${e.message}`);
    }
  }
  writeArticles(quiz, { [golden.id]: runsBySlug(goldenQuiz), [id]: runsBySlug(challengerQuiz) });
} else {
  writeJSON(`prompts/${model}/active.json`, []);
  if (search?.goldenRuns) writeArticles(search, { [golden.id]: runsBySlug(search.goldenRuns) });
}

// Three closest misses get a loser file.
const misses = report.attempts
  .filter((a) => !a.passed && a.prompt)
  .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
  .slice(0, 3);
let nextId = Number(nextPromptId(model).slice(2));
for (const m of misses) {
  m.loserId = "p-" + String(nextId++).padStart(4, "0");
  writeLoser(model, { id: m.loserId, date, stage: `eval (${m.stage})`, reason: m.reason, score: m.score, prompt: m.prompt, report: reportPath });
}

// Tested submissions leave the queue; their result is in the report (and a loser file if close).
for (const q of tested) fs.rmSync(path.join(ROOT, q), { force: true });

report.tokensUsed = ctx.budget.used;
report.autoMerge = autoMerge;
writeJSON(reportPath, report);

// 5. PR text and workflow outputs.
const stageCounts = report.attempts.reduce((acc, a) => ((acc[a.passed ? "passed" : a.stage] = (acc[a.passed ? "passed" : a.stage] || 0) + 1), acc), {});
const row = (label, sc) => sc ? `| ${label} | ${sc.n} | ${pct(sc.coverage)} | ${pct(sc.floor)} | ${pct(1 - sc.lengthRatio)} | ${sc.candUnsupported} / ${sc.baseUnsupported} |` : "";
const title = winner
  ? `Weekly eval ${date}: new challenger ${report.challenger.id}`
  : `Weekly eval ${date}: no challenger${report.outcome === "budget" ? " (budget spent)" : ""}`;

// golden-pull.js runs first in the same job; its decision leads the PR.
const decisionFile = path.join(ROOT, ".cache/decision.json");
const decision = fs.existsSync(decisionFile) ? JSON.parse(fs.readFileSync(decisionFile, "utf8")) : null;
const fullTitle = decision && decision.outcome !== "none" ? `${decision.title}. ${title}` : title;

let body = decision?.body ? decision.body + "\n" : "";
body += `## ${title}\n\n`;
body += `Golden **${golden.id}** ${report.golden.passed ? "still passes" : "**fails**"} the gate. ${report.golden.reason || ""}\n\n`;
body += `| Set | Articles | Coverage vs baseline | Worst article | Shorter than baseline | Unsupported (prompt / base) |\n|---|---|---|---|---|---|\n`;
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
if (misses.length) body += `### Close but no cigar\n\n${misses.map((m) => `- \`${m.loserId}\`: ${m.reason}`).join("\n")}\n\n`;
body += `Tokens used: ${ctx.budget.used.toLocaleString()}. Full log: \`${reportPath}\`.\n`;

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
