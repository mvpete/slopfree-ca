// Health check: the golden prompt against the plain summary (cfg.health).
//
//   node scripts/eval-golden.js [articles]
import { loadConfig } from "./lib/config.js";
import { createContext, prepareArticles, runPrompt, scoreRuns } from "./lib/eval.js";
import { readGolden, writeJSON } from "./lib/store.js";
import { reasonOf } from "./lib/gate.js";
import { spendLine } from "./lib/llm.js";
import { today, pct } from "./lib/util.js";

const cfg = loadConfig();
const n = Number(process.argv[2]) || cfg.articles;
const ctx = createContext(cfg);
const golden = readGolden(cfg.model);
const h = cfg.health;
const x = (v) => (Number.isFinite(v) ? v.toFixed(2) + "×" : "n/a");

ctx.log(`checking golden ${golden.id} on ${n} articles${cfg.dryRun ? " (dry run)" : ""}`);
const articles = await prepareArticles(ctx, n, new Set());
const runs = await runPrompt(ctx, golden.text, articles);
const r = scoreRuns(cfg, articles, runs, { gate: h });
const sc = r.score;

console.log(`
Golden prompt ${golden.id}: ${r.gate.passed ? "HEALTHY" : "UNHEALTHY"}
  Summaries by ${cfg.writerModel}, judged by ${cfg.judgeModel}
  Key points vs plain          ${pct(sc.coverage)}   (needs >= ${pct(h.coverage)})
  Net key points per word      ${x(sc.composite)} plain   (needs >= ${x(1 + h.margin)})
  Length vs plain              ${pct(sc.lengthRatio)}   (for information)
  Worst article, key points    ${pct(sc.floor)}   (for information)
  Em dashes                    ${sc.candDashes}   (needs 0)
  AI-style phrases             ${sc.candStyle} vs plain ${sc.baseStyle}
  Unsupported claims           ${sc.candUnsupported} vs plain ${sc.baseUnsupported}
  ${reasonOf(r.gate)}
  Cost: $${ctx.budget.usd.toFixed(2)} (${spendLine(ctx.budget)})`);

writeJSON(`evals/golden-${today()}.json`, {
  date: today(),
  golden: golden.id,
  writerModel: cfg.writerModel,
  judgeModel: cfg.judgeModel,
  gate: h,
  passed: r.gate.passed,
  reason: reasonOf(r.gate),
  score: sc,
  stats: r.stats,
  usd: Math.round(ctx.budget.usd * 100) / 100,
  articles: articles.map((a, i) => ({ ...a.source, baseline: a.baseline.summary, golden: runs[i].summary })),
});
process.exitCode = r.gate.passed ? 0 : 1;
