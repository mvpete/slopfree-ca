// Pure scoring: no I/O, so CI can re-check a report from its stored numbers.
//
// Weighted points per word. Every point in the article is labelled key or detail when it's listed.
// A kept key point is worth 1, a kept detail point is worth gate.detailWeight (0 by default), so a
// summary gains nothing from padding with trivia. Two things are compared with the plain summary:
//   accuracy:   weighted points kept, as a share of the plain summary's (gate.coverage, e.g. 95%)
//   efficiency: weighted points per word, as a multiple of the plain summary's. gate.efficiency = 0.15
//               means 1 / (1 - 0.15) = 1.18x: the same key points in 15% fewer words.
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
    baseOfArticlePoints: sum("totalPoints") ? sum("baseCovered") / sum("keyPoints") : NaN,
    baseOfArticleWords: valid.every((s) => s.articleWords) ? median(valid.map((s) => s.baseWords / s.articleWords)) : NaN,
    worst: per.slice(0, 3),
  };
}

export const neededDensity = (gate) => 1 / (1 - gate.efficiency);
const x = (v) => (Number.isFinite(v) ? v.toFixed(2) + "×" : "n/a");

export function checkGate(sc, gate) {
  const failures = [];
  const need = neededDensity(gate);
  if (!sc.n) failures.push({ check: "data", message: "No usable articles." });
  else {
    if (sc.coverage < gate.coverage)
      failures.push({ check: "coverage", message: `Kept ${pct(sc.coverage)} as many key points as the baseline (needs ${pct(gate.coverage)}; ${round(sc.kept)} vs ${round(sc.baseKept)}).` });
    if (sc.density < need)
      failures.push({
        check: "efficiency",
        message: `Key points per word: ${x(sc.density)} the baseline (needs ${x(need)}, the same key points in ${pct(gate.efficiency)} fewer words; ${sc.candWords} words vs baseline's ${sc.baseWords} across ${sc.n} articles).`,
      });
    if (sc.candUnsupported > sc.baseUnsupported)
      failures.push({ check: "accuracy", message: `${sc.candUnsupported} unsupported claims vs baseline's ${sc.baseUnsupported}.` });
    if (sc.candDashes > 0)
      failures.push({ check: "dashes", message: `${sc.candDashes} em dash${sc.candDashes === 1 ? "" : "es"} in the summaries (needs none).` });
    if (sc.candStyle > sc.baseStyle)
      failures.push({ check: "style", message: `${sc.candStyle} literary or AI-style phrases vs baseline's ${sc.baseStyle}.` });
    if (sc.floor < gate.floor)
      failures.push({ check: "floor", message: `Worst article kept ${pct(sc.floor)} as many key points as the baseline (needs ${pct(gate.floor)}).` });
  }
  // How far from passing, for ranking near-misses. 0 means passed.
  const short = (have, needed) => Math.max(0, needed - have) / needed;
  const distance = !sc.n
    ? Infinity
    : short(sc.coverage, gate.coverage) +
      short(sc.floor, gate.floor) +
      short(sc.density, need) +
      Math.max(0, sc.candUnsupported - sc.baseUnsupported) / Math.max(1, sc.n) +
      (sc.candDashes || 0) / Math.max(1, sc.n) +
      Math.max(0, (sc.candStyle || 0) - (sc.baseStyle || 0)) / Math.max(1, sc.n);
  return { passed: failures.length === 0, failures, distance };
}

const round = (v) => (Number.isInteger(v) ? v : Math.round(v * 10) / 10);
export const reasonOf = (result) => result.failures.map((f) => f.message).join(" ") || "Passed.";
