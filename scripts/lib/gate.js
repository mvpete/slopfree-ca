// Pure scoring: no I/O, so CI can re-check a report from its stored numbers.
import { median, pct } from "./util.js";

// Per-article numbers. Coverage only counts points the baseline covered.
export function articleStats(slug, base, cand, articleWords = null) {
  let baseCovered = 0;
  let kept = 0;
  base.covered.forEach((c, i) => {
    if (!c) return;
    baseCovered++;
    if (cand.covered[i]) kept++;
  });
  return {
    slug,
    totalPoints: base.covered.length,
    articleWords,
    baseCovered,
    kept,
    baseUnsupported: base.unsupported,
    candUnsupported: cand.unsupported,
    baseWords: base.words,
    candWords: cand.words,
  };
}

export function score(stats) {
  const valid = stats.filter((s) => s.baseCovered > 0 && s.baseWords > 0);
  const sum = (k) => valid.reduce((a, s) => a + s[k], 0);
  const per = valid
    .map((s) => ({ slug: s.slug, coverage: s.kept / s.baseCovered, ratio: s.candWords / s.baseWords }))
    .sort((a, b) => a.coverage - b.coverage);
  return {
    n: valid.length,
    coverage: valid.length ? sum("kept") / sum("baseCovered") : NaN,
    floor: per.length ? per[0].coverage : NaN,
    lengthRatio: median(per.map((p) => p.ratio)),
    baseUnsupported: sum("baseUnsupported"),
    candUnsupported: sum("candUnsupported"),
    baseWords: sum("baseWords"),
    candWords: sum("candWords"),
    // Baseline vs the article itself: share of all points it keeps, and its length as a share of the article.
    baseOfArticlePoints: sum("totalPoints") ? sum("baseCovered") / sum("totalPoints") : NaN,
    baseOfArticleWords: valid.every((s) => s.articleWords) ? median(valid.map((s) => s.baseWords / s.articleWords)) : NaN,
    worst: per.slice(0, 3),
  };
}

export function checkGate(sc, gate) {
  const failures = [];
  if (!sc.n) failures.push({ check: "data", message: "No usable articles." });
  else {
    if (sc.coverage < gate.coverage)
      failures.push({ check: "coverage", message: `Covered ${pct(sc.coverage)} of baseline points (needs ${pct(gate.coverage)}).` });
    if (sc.candUnsupported > sc.baseUnsupported)
      failures.push({ check: "accuracy", message: `${sc.candUnsupported} unsupported claims vs baseline's ${sc.baseUnsupported}.` });
    if (sc.lengthRatio > gate.lengthRatio)
      failures.push({
        check: "length",
        message:
          (sc.lengthRatio > 1
            ? `${pct(sc.lengthRatio - 1)} longer than baseline`
            : `Only ${pct(1 - sc.lengthRatio)} shorter than baseline`) +
          ` (needs ${pct(1 - gate.lengthRatio)} shorter; ${sc.candWords} words vs baseline's ${sc.baseWords} across ${sc.n} articles).`,
      });
    if (sc.floor < gate.floor)
      failures.push({ check: "floor", message: `Worst article kept ${pct(sc.floor)} of baseline points (needs ${pct(gate.floor)}).` });
  }
  // How far from passing, for ranking near-misses. 0 means passed.
  const short = (have, need) => Math.max(0, need - have) / need;
  const distance = !sc.n
    ? Infinity
    : short(sc.coverage, gate.coverage) +
      short(sc.floor, gate.floor) +
      Math.max(0, sc.lengthRatio - gate.lengthRatio) / gate.lengthRatio +
      Math.max(0, sc.candUnsupported - sc.baseUnsupported) / Math.max(1, sc.n);
  return { passed: failures.length === 0, failures, distance };
}

export const reasonOf = (result) => result.failures.map((f) => f.message).join(" ") || "Passed.";
