// Pure scoring for the weekly search: no I/O, so CI can re-check any stored report.
//
// A prompt is measured on a set of articles, all written by one writer and graded by one judge.
// Per article we keep the raw judgment (run) and the plain summary's raw judgment (plain):
//   run/plain: { words, dashes, covered: [bool per key point], unsupported, style }
//
// Hard constraints (cfg.qualification, and the looser cfg.screening) decide pass or fail. Every
// criterion is optional: leave it out or set it to null to turn it off.
//   keyPointCoverage { min }       key points kept / all key points in the answer key, pooled
//   compression      { min }       1 - words / the plain summary's words, pooled
//   unsupported      { max }       claims the article doesn't back, total
//   emDashes         { max }       counted by code, total
//   style            { max }       AI-style phrases, total
//                    { maxOverPlain }  ... or at most this many more than the plain summaries had
//
// Beyond the constraints, cfg.objectives weights four continuous objectives into one ranking score.
// These are a first guess, recorded with every report so they can be tuned against reader results.

const fmt = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "n/a");
const has = (c) => c !== undefined && c !== null;

// One article's numbers. plain may be ungraded (words only); then style/density vs plain are unknown.
export function articleRow(slug, plain, run) {
  const keyPoints = run.covered.length;
  return {
    slug,
    keyPoints,
    kept: run.covered.filter(Boolean).length,
    words: run.words,
    unsupported: run.unsupported ?? 0,
    dashes: run.dashes ?? 0,
    style: run.style ?? 0,
    plainWords: plain.words,
    plainKept: plain.covered ? plain.covered.filter(Boolean).length : null,
    plainStyle: plain.style ?? null,
    plainUnsupported: plain.unsupported ?? null,
  };
}

export function scoreSet(rows) {
  const valid = rows.filter((r) => r.keyPoints > 0 && r.words > 0 && r.plainWords > 0);
  const sum = (k) => valid.reduce((a, r) => a + r[k], 0);
  const n = valid.length;
  const graded = valid.every((r) => r.plainKept !== null);
  const keyPoints = sum("keyPoints");
  const kept = sum("kept");
  const words = sum("words");
  const plainWords = sum("plainWords");
  const plainKept = graded ? sum("plainKept") : null;
  const perArticle = valid.map((r) => ({ slug: r.slug, coverage: r.kept / r.keyPoints, compression: 1 - r.words / r.plainWords })).sort((a, b) => a.coverage - b.coverage);
  return {
    n,
    keyPoints,
    kept,
    coverage: n ? kept / keyPoints : NaN,
    words,
    plainWords,
    compression: n ? 1 - words / plainWords : NaN,
    unsupported: sum("unsupported"),
    dashes: sum("dashes"),
    style: sum("style"),
    plainKept,
    plainCoverage: graded && n ? plainKept / keyPoints : null,
    plainStyle: graded ? sum("plainStyle") : null,
    plainUnsupported: graded ? sum("plainUnsupported") : null,
    // Key points per word, as a multiple of the plain summary's. Needs the plain summary graded.
    density: graded && plainKept > 0 && words > 0 ? kept / words / (plainKept / plainWords) : null,
    worst: perArticle.slice(0, 3), // for information only; never a constraint
  };
}

// Each check gives a signed margin: positive means room to spare, negative means short by that much.
const CHECKS = {
  keyPointCoverage: (sc, c) => ({ have: sc.coverage, need: c.min, margin: sc.coverage - c.min, message: `Kept ${fmt(sc.coverage)} of the key points (needs ${fmt(c.min)}; ${sc.kept} of ${sc.keyPoints}).` }),
  compression: (sc, c) => ({ have: sc.compression, need: c.min, margin: sc.compression - c.min, message: `${fmt(sc.compression)} shorter than the plain summary (needs ${fmt(c.min)}; ${sc.words} words vs ${sc.plainWords}).` }),
  unsupported: (sc, c) => ({ have: sc.unsupported, need: c.max, margin: c.max - sc.unsupported, message: `${sc.unsupported} unsupported claim${sc.unsupported === 1 ? "" : "s"} (allowed: ${c.max}).` }),
  emDashes: (sc, c) => ({ have: sc.dashes, need: c.max, margin: c.max - sc.dashes, message: `${sc.dashes} em dash${sc.dashes === 1 ? "" : "es"} (allowed: ${c.max}).` }),
  style: (sc, c) => {
    if (has(c.maxOverPlain)) {
      if (sc.plainStyle === null) return { have: sc.style, need: null, margin: null, message: "Style can't be checked: the plain summaries weren't graded." };
      const need = sc.plainStyle + c.maxOverPlain;
      return { have: sc.style, need, margin: need - sc.style, message: `${sc.style} AI-style phrases vs the plain summaries' ${sc.plainStyle} (allowed: ${need}).` };
    }
    return { have: sc.style, need: c.max, margin: c.max - sc.style, message: `${sc.style} AI-style phrases (allowed: ${c.max}).` };
  },
};

// Scale for ranking near-misses: how much one unit of shortfall matters per criterion.
const SCALE = { keyPointCoverage: (sc) => 0.1, compression: (sc) => 0.1, unsupported: (sc) => Math.max(1, sc.n), emDashes: (sc) => Math.max(1, sc.n), style: (sc) => Math.max(1, sc.n) };

// criteria: cfg.qualification or cfg.screening. Returns every margin, pass or fail, so thresholds can
// be calibrated from real runs (golden's included).
export function qualify(sc, criteria) {
  const margins = {};
  const failures = [];
  if (!sc.n) return { passed: false, margins, failures: [{ check: "data", message: "No usable articles." }], distance: Infinity };
  let distance = 0;
  for (const [key, check] of Object.entries(CHECKS)) {
    const c = criteria[key];
    if (!has(c)) continue;
    const m = check(sc, c);
    margins[key] = { have: m.have, need: m.need, margin: m.margin };
    if (m.margin === null) {
      failures.push({ check: key, message: m.message });
      distance += 1;
    } else if (m.margin < 0) {
      failures.push({ check: key, message: m.message });
      distance += -m.margin / SCALE[key](sc);
    }
  }
  return { passed: failures.length === 0, margins, failures, distance };
}

// Continuous objectives beyond the constraints, weighted by cfg.objectives. Higher is better.
// Each term is roughly "one unit = a clearly noticeable improvement":
//   coverage +10 points, compression +10 points, density +10%, one fewer AI-style phrase per article.
export function objectiveScore(sc, weights = {}) {
  const w = (k) => weights[k] ?? 0;
  const terms = {
    keyPointCoverage: Number.isFinite(sc.coverage) ? sc.coverage / 0.1 : 0,
    compression: Number.isFinite(sc.compression) ? sc.compression / 0.1 : 0,
    density: sc.density !== null && Number.isFinite(sc.density) ? (sc.density - 1) / 0.1 : 0,
    style: sc.plainStyle !== null && sc.n ? (sc.plainStyle - sc.style) / sc.n : 0,
  };
  const total = Object.entries(terms).reduce((a, [k, v]) => a + w(k) * v, 0);
  return { total, terms };
}

// Deterministic order: passing first, then nearest to passing, then the objective score, then
// shorter prompt text, then attempt number. No model is asked to choose.
export function rank(a, b) {
  return (
    Number(b.result.passed) - Number(a.result.passed) ||
    a.result.distance - b.result.distance ||
    b.objective.total - a.objective.total ||
    a.promptLength - b.promptLength ||
    a.n - b.n
  );
}

// Score stored runs again, exactly as the run did: runs and plains are lists of raw judgments
// ({ slug, words, dashes, covered, unsupported, style }), matched by slug.
export function measure(runs, plains) {
  const bySlug = Object.fromEntries(plains.map((p) => [p.slug, p]));
  return scoreSet(runs.filter((r) => bySlug[r.slug]).map((r) => articleRow(r.slug, bySlug[r.slug], r)));
}

export const reasonOf = (result) => result.failures.map((f) => f.message).join(" ") || "Passed.";
