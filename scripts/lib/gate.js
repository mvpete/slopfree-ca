// Pure scoring: no I/O, so CI can re-check a report from its stored numbers.
//
// articleStats compares one prompt's run (cand) with a reference run (base) on the same article. The
// reference is golden in the weekly search, and the plain summary when checking golden's health.
// A kept key point is worth 1, a kept detail point gate.detailWeight (0), so padding never helps.
//   coverage:  key points kept, as a share of the reference's
//   composite: (key points kept - unsupported claims) per word, as a multiple of the reference's
import { median, pct } from "./util.js";

// weights[i] is what point i is worth when kept. Missing weights (older data) count every point as 1.
export function articleStats(slug, base, cand, articleWords = null, weights = null) {
  const w = (i) => (weights ? weights[i] : 1);
  const sumKept = (covered) => covered.reduce((a, c, i) => a + (c ? w(i) : 0), 0);
  return {
    slug,
    totalPoints: base.covered.length,
    keyPoints: weights ? weights.filter((x) => x === 1).length : base.covered.length,
    articleWords,
    baseCovered: sumKept(base.covered), // weighted
    kept: sumKept(cand.covered), // weighted
    overlap: base.covered.reduce((a, c, i) => a + (c && cand.covered[i] ? w(i) : 0), 0),
    baseUnsupported: base.unsupported,
    candUnsupported: cand.unsupported,
    baseWords: base.words,
    candWords: cand.words,
    // AI-style writing: em dashes counted mechanically, literary devices flagged by the judge.
    baseDashes: base.dashes ?? 0,
    candDashes: cand.dashes ?? 0,
    baseStyle: base.style ?? 0,
    candStyle: cand.style ?? 0,
  };
}

export function score(stats) {
  const valid = stats.filter((s) => s.baseCovered > 0 && s.baseWords > 0 && s.candWords > 0);
  const sum = (k) => valid.reduce((a, s) => a + s[k], 0);
  const per = valid
    .map((s) => ({
      slug: s.slug,
      coverage: s.kept / s.baseCovered,
      ratio: s.candWords / s.baseWords,
      density: s.kept / s.candWords / (s.baseCovered / s.baseWords),
    }))
    .sort((a, b) => a.coverage - b.coverage);
  return {
    n: valid.length,
    coverage: valid.length ? sum("kept") / sum("baseCovered") : NaN,
    floor: per.length ? per[0].coverage : NaN,
    density: median(per.map((p) => p.density)), // weighted points per word vs plain, median article
    lengthRatio: median(per.map((p) => p.ratio)), // for information
    baseUnsupported: sum("baseUnsupported"),
    candUnsupported: sum("candUnsupported"),
    kept: sum("kept"),
    baseKept: sum("baseCovered"),
    overlap: sum("overlap"),
    baseWords: sum("baseWords"),
    candWords: sum("candWords"),
    baseDashes: sum("baseDashes"),
    candDashes: sum("candDashes"),
    baseStyle: sum("baseStyle"),
    candStyle: sum("candStyle"),
    // Composite: net key points (kept minus unsupported claims) per word, as a multiple of the plain
    // summary's. Higher is better; 1.00 = plain.
    composite: (() => {
      const cand = (sum("kept") - sum("candUnsupported")) / sum("candWords");
      const base = (sum("baseCovered") - sum("baseUnsupported")) / sum("baseWords");
      return base > 0 ? cand / base : NaN;
    })(),
    baseOfArticlePoints: sum("totalPoints") ? sum("baseCovered") / sum("keyPoints") : NaN,
    baseOfArticleWords: valid.every((s) => s.articleWords) ? median(valid.map((s) => s.baseWords / s.articleWords)) : NaN,
    worst: per.slice(0, 3),
  };
}

export const neededDensity = (gate) => 1 / (1 - gate.efficiency);
const x = (v) => (Number.isFinite(v) ? v.toFixed(2) + "×" : "n/a");
const has = (v) => v !== undefined && v !== null;

// Every check is optional, so one function covers both gates and older reports still re-check in CI:
//   gate.vs          what the stats compare against: "golden" (weekly search) or "plain summary"
//   gate.coverage    key points kept, as a share of the reference's
//   gate.margin      composite (net key points per word) must beat the reference by this much
//   gate.efficiency  older reports: key points per word, 1 / (1 - efficiency) × the reference's
//   gate.floor       older reports: the worst single article's coverage
// Em dashes, unsupported claims and AI-style phrases are always checked against the reference.
export function checkGate(sc, gate) {
  const ref = gate.vs || "the baseline";
  const the = ref === "golden" ? "golden" : ref.startsWith("the ") ? ref : `the ${ref}`;
  const failures = [];
  if (!sc.n) failures.push({ check: "data", message: "No usable articles." });
  else {
    if (has(gate.coverage) && sc.coverage < gate.coverage)
      failures.push({ check: "coverage", message: `Kept ${pct(sc.coverage)} as many key points as ${the} (needs ${pct(gate.coverage)}; ${round(sc.kept)} vs ${round(sc.baseKept)}).` });
    if (has(gate.margin) && !(sc.composite >= 1 + gate.margin))
      failures.push({
        check: "margin",
        message: `Net key points per word: ${x(sc.composite)} ${the}'s (needs ${x(1 + gate.margin)}; ${sc.candWords} words vs ${sc.baseWords} across ${sc.n} articles).`,
      });
    if (has(gate.efficiency) && sc.density < neededDensity(gate))
      failures.push({
        check: "efficiency",
        message: `Key points per word: ${x(sc.density)} ${the} (needs ${x(neededDensity(gate))}, the same key points in ${pct(gate.efficiency)} fewer words; ${sc.candWords} words vs ${the}'s ${sc.baseWords} across ${sc.n} articles).`,
      });
    if (sc.candUnsupported > sc.baseUnsupported)
      failures.push({ check: "accuracy", message: `${sc.candUnsupported} unsupported claims vs ${the}'s ${sc.baseUnsupported}.` });
    if (sc.candDashes > 0)
      failures.push({ check: "dashes", message: `${sc.candDashes} em dash${sc.candDashes === 1 ? "" : "es"} in the summaries (needs none).` });
    if (sc.candStyle > sc.baseStyle)
      failures.push({ check: "style", message: `${sc.candStyle} literary or AI-style phrases vs ${the}'s ${sc.baseStyle}.` });
    if (has(gate.floor) && sc.floor < gate.floor)
      failures.push({ check: "floor", message: `Worst article kept ${pct(sc.floor)} as many key points as ${the} (needs ${pct(gate.floor)}).` });
  }
  // How far from passing, for ranking near-misses. 0 means passed.
  const short = (have, needed) => Math.max(0, needed - have) / needed;
  const per = (n) => n / Math.max(1, sc.n);
  const distance = !sc.n
    ? Infinity
    : (has(gate.coverage) ? short(sc.coverage, gate.coverage) : 0) +
      (has(gate.margin) ? short(Number.isFinite(sc.composite) ? sc.composite : 0, 1 + gate.margin) : 0) +
      (has(gate.efficiency) ? short(sc.density, neededDensity(gate)) : 0) +
      (has(gate.floor) ? short(sc.floor, gate.floor) : 0) +
      per(Math.max(0, sc.candUnsupported - sc.baseUnsupported)) +
      per(sc.candDashes || 0) +
      per(Math.max(0, (sc.candStyle || 0) - (sc.baseStyle || 0)));
  return { passed: failures.length === 0, failures, distance };
}

const round = (v) => (Number.isInteger(v) ? v : Math.round(v * 10) / 10);
export const reasonOf = (result) => result.failures.map((f) => f.message).join(" ") || "Passed.";
