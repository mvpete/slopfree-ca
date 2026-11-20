// Check the current golden prompt against the gate. Golden v1 must pass this before launch.
//
//   node scripts/eval-golden.js [articles]
import { loadConfig } from "./lib/config.js";
import { createContext, prepareArticles, runPrompt, scoreRuns } from "./lib/eval.js";
import { readGolden, writeJSON } from "./lib/store.js";
import { reasonOf } from "./lib/gate.js";
import { today, pct } from "./lib/util.js";

const cfg = loadConfig();
const n = Number(process.argv[2]) || cfg.articles;
const ctx = createContext(cfg);
const golden = readGolden(cfg.model);

ctx.log(`checking golden ${golden.id} on ${n} articles${cfg.dryRun ? " (dry run)" : ""}`);
const articles = await prepareArticles(ctx, n, new Set());
const runs = await runPrompt(ctx, golden.text, articles);
const r = scoreRuns(cfg, articles, runs);
const sc = r.score;

console.log(`
Golden prompt ${golden.id}: ${r.gate.passed ? "PASS" : "FAIL"}
  Summaries by ${cfg.writerModel}, judged by ${cfg.judgeModel}
  Coverage vs baseline   ${pct(sc.coverage)}   (needs >= ${pct(cfg.gate.coverage)})
  Worst article          ${pct(sc.floor)}   (needs >= ${pct(cfg.gate.floor)})
  Shorter than baseline  ${pct(1 - sc.lengthRatio)}   (needs >= ${pct(1 - cfg.gate.lengthRatio)})
  Unsupported claims     ${sc.candUnsupported} vs baseline ${sc.baseUnsupported}
  ${reasonOf(r.gate)}
  Tokens used: ${ctx.budget.used.toLocaleString()}`);

writeJSON(`evals/golden-${today()}.json`, {
  date: today(),
  golden: golden.id,
  writerModel: cfg.writerModel,
  judgeModel: cfg.judgeModel,
  passed: r.gate.passed,
  reason: reasonOf(r.gate),
  score: sc,
  stats: r.stats,
  articles: articles.map((a, i) => ({ ...a.source, baseline: a.baseline.summary, golden: runs[i].summary })),
});
process.exitCode = r.gate.passed ? 0 : 1;
