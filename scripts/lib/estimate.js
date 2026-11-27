// Cost estimates, made before each stage runs, so a stage that won't fit is skipped, not cut off.
// Pure: prices and token guesses in, dollars out.
//
// A plan is a list of calls: { model, role, calls, input, cachedInput, output }
//   input        tokens sent fresh on each call
//   cachedInput  tokens repeated across calls to one article (article + key points), Claude only:
//                the first call writes the cache (1.25x), the rest read it (0.1x)
//   output       tokens per call; if omitted, the run's observed average for this role, else the
//                configured guess (cfg.budget.assumedOutputTokens)

export const tokensFor = (words) => Math.ceil(words * 1.35);

const SYSTEM = 400; // a system prompt, roughly
const KEY_POINTS_LIST = 30 * 20; // up to 30 key points of ~20 tokens

export function callCost(prices, { model, calls, input = 0, cachedInput = 0, output = 0, perArticle = calls }) {
  const p = prices[model] || { input: Math.max(...Object.values(prices).map((x) => x.input)), output: Math.max(...Object.values(prices).map((x) => x.output)) };
  const claude = /^claude-/.test(model);
  // perArticle: how many calls share each cached prefix; one cache write per group.
  const groups = Math.max(1, Math.ceil(calls / Math.max(1, perArticle)));
  const cached = claude ? groups * cachedInput * 1.25 + (calls - groups) * cachedInput * 0.1 : calls * cachedInput;
  return ((calls * input + cached) * p.input + calls * output * p.output) / 1e6;
}

// observed: { role: { calls, output } } from the running budget; assumed: cfg.budget.assumedOutputTokens.
export function outputFor(role, observed = {}, assumed = {}) {
  const o = observed[role];
  return o && o.calls ? o.output / o.calls : assumed[role] ?? 1000;
}

export function planCost(prices, plan, { observed, assumed } = {}) {
  return plan.reduce((sum, c) => sum + callCost(prices, { ...c, output: c.output ?? outputFor(c.role, observed, assumed) }), 0);
}

// The calls for each stage, from article sizes. words: average article words.
const judgeCall = (spec, n, words, role) => ({ model: spec.model, role, calls: n, input: SYSTEM + 600, cachedInput: tokensFor(words) + KEY_POINTS_LIST, perArticle: 1 });
export const stages = {
  // Answer keys for n articles, from the judge's family.
  keyPoints: ({ cfg, n, words }) => [{ model: cfg.writer.keyPoints.model, role: "keyPoints", calls: n, input: SYSTEM + tokensFor(words) }],
  // Each writer's plain summary on n articles, graded by that writer's judge (or not).
  plain: ({ cfg, n, words, graded = true }) => cfg.writers.flatMap((w) => [{ model: w.model, role: "summary", calls: n, input: tokensFor(words) }, ...(graded ? [judgeCall(w.judge, n, words, "judge")] : [])]),
  // One prompt written and graded by every writer on n articles. screen: use the cheap judges.
  run: ({ cfg, n, words, promptTokens, screen = false }) => cfg.writers.flatMap((w) => [{ model: w.model, role: "summary", calls: n, input: tokensFor(words) + promptTokens }, judgeCall(screen ? w.screenJudge : w.judge, n, words, screen ? "screenJudge" : "judge")]),
  // Re-grade n existing summaries per writer.
  rejudge: ({ cfg, n, words, screen = false }) => cfg.writers.map((w) => judgeCall(screen ? w.screenJudge : w.judge, n, words, screen ? "screenJudge" : "judge")),
  draft: ({ cfg, historyTokens = 15000 }) => [{ model: cfg.drafter.model, role: "drafter", calls: 1, input: SYSTEM * 3 + historyTokens }],
  // Quiz-only articles, one writer each: golden and challenger summaries, both checked for
  // unsupported claims by the cheap judge before publication, and a question.
  quiz: ({ cfg, n, words, promptTokens }) => {
    const per = Math.ceil(n / cfg.writers.length);
    return [
      ...cfg.writers.flatMap((w) => [{ model: w.model, role: "summary", calls: 2 * per, input: tokensFor(words) + promptTokens }, { ...judgeCall(w.screenJudge, 2 * per, words, "screenJudge"), perArticle: 2 }]),
      { model: cfg.questions.model, role: "question", calls: n, input: SYSTEM + 1200 },
    ];
  },
};

// The whole week, for `npm run estimate` and the PR. drafts: how many drafter calls (0 when the pool
// is filled from earlier prompts). Assumes every stage runs.
export function weekPlan(cfg, { words = 2400, promptTokens = 300, drafts = 1 } = {}) {
  const a = cfg.articles;
  const s = cfg.search;
  const rest = a.search - a.screen;
  const quizOnly = Math.max(0, a.quiz - a.confirm);
  const parts = {
    [`search set: ${a.search} answer keys, plain summaries graded`]: [...stages.keyPoints({ cfg, n: a.search, words }), ...stages.plain({ cfg, n: a.search, words })],
    [`drafting (${drafts} call${drafts === 1 ? "" : "s"})`]: Array.from({ length: drafts }, () => stages.draft({ cfg })).flat(),
    [`screening ${s.pool} candidates on ${a.screen} articles`]: [...stages.rejudge({ cfg, n: a.screen, words, screen: true }), ...Array.from({ length: s.pool }, () => stages.run({ cfg, n: a.screen, words, promptTokens, screen: true })).flat()],
    [`full run, ${s.finalists} finalists`]: Array.from({ length: s.finalists }, () => [...stages.rejudge({ cfg, n: a.screen, words }), ...stages.run({ cfg, n: rest, words, promptTokens })]).flat(),
    [`unseen set: ${a.confirm} answer keys, plain summaries graded`]: [...stages.keyPoints({ cfg, n: a.confirm, words }), ...stages.plain({ cfg, n: a.confirm, words })],
    "confirm: challenger and golden (golden for the fight card only)": [...stages.run({ cfg, n: a.confirm, words, promptTokens }), ...stages.run({ cfg, n: a.confirm, words, promptTokens })],
    [`quiz: ${quizOnly} more articles, publication checks`]: stages.quiz({ cfg, n: quizOnly, words, promptTokens }),
  };
  const opts = { assumed: cfg.budget.assumedOutputTokens };
  const lines = Object.entries(parts).map(([label, plan]) => ({ label, usd: planCost(cfg.budget.prices, plan, opts) }));
  return { lines, total: lines.reduce((x, l) => x + l.usd, 0) };
}
