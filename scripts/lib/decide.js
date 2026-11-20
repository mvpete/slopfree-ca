// Reader-test decision: did the challenger beat golden this week?
// Pure and seeded, so CI can recompute the same verdict from the data snapshot.
//
// Sized for very few readers (about 25 answers a week, possibly one person):
// - Speed is the main signal. Reading time is relative to the median of the quiz it came from (log scale).
// - Accuracy is a veto. With ~12 answers per prompt it can catch a clearly worse challenger, not prove equality;
//   the machine eval already guarantees the summaries keep the facts.
// - A Bayesian bootstrap over answers gives the probabilities.
// Win = >= 90% chance readers were faster, AND under 60% chance accuracy dropped by more than 10 points.
// Simulated 25-answer weeks: a 23%-faster equal-accuracy challenger wins ~57%; one that isn't faster ~12%;
// one at 40% vs 75% accuracy ~12%. Two weeks of answers (50) raise the first to ~81%.
import { median, pct } from "./util.js";

export const DEFAULTS = {
  minAnswers: 10, // per prompt
  fasterConfidence: 0.9,
  worseMargin: 0.1,
  worseConfidence: 0.6,
  samples: 4000,
  maxWpm: 1500,
  maxReadMs: 600000,
  guessRetire: 0.6,
  guessMin: 10,
  subgroupMin: 30,
};

export function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (const c of seed) {
    h = Math.imul(h ^ c.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
function groupBy(rows, f) {
  const m = new Map();
  for (const r of rows) {
    const k = f(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

const describe = (acc, time) => {
  const pts = Math.abs(acc * 100).toFixed(0);
  const a = Math.abs(acc) < 0.005 ? "scored the same" : `scored ${pts} points ${acc > 0 ? "higher" : "lower"}`;
  const t = Math.exp(time) - 1;
  return `${a} and read ${Math.abs(t * 100).toFixed(0)}% ${t <= 0 ? "faster" : "slower"}`;
};

// rows: { session_id, prompt_id, slug, choice, read_ms, words, guess, hidden, first_language }
// key:  { [slug]: index of the correct option }
export function decide(rows, { golden, challenger, key, seed, ...options }) {
  const o = { ...DEFAULTS, ...options };
  const correct = (r) => Number(r.choice === key[r.slug]);
  const known = (r) => key[r.slug] !== undefined;

  // Guess rounds (question without a summary), if any were served, measure how guessable an article is.
  const guess = {};
  for (const r of rows.filter((r) => r.guess && known(r))) {
    const g = (guess[r.slug] ||= { n: 0, correct: 0 });
    g.n++;
    g.correct += correct(r);
  }
  const tooGuessable = new Set(
    Object.entries(guess).filter(([, g]) => g.n >= o.guessMin && g.correct / g.n >= o.guessRetire).map(([s]) => s)
  );

  let main = rows.filter(
    (r) =>
      !r.guess &&
      !r.hidden &&
      (r.prompt_id === golden || r.prompt_id === challenger) &&
      known(r) &&
      !tooGuessable.has(r.slug) &&
      r.read_ms > 0 &&
      r.read_ms <= o.maxReadMs &&
      r.words / (r.read_ms / 60000) <= o.maxWpm
  );

  // Junk quizzes: abandoned after one answer. (No "same option every time" rule: options are shuffled on
  // screen and stored by original index, so a perfect reader can look identical to that pattern.)
  const junk = new Set();
  for (const [s, rs] of groupBy(main, (r) => r.session_id)) if (rs.length < 2) junk.add(s);
  main = main.filter((r) => !junk.has(r.session_id));

  // Reading time relative to the quiz it came from, so a slow day doesn't count against one prompt.
  const med = new Map();
  for (const [s, rs] of groupBy(main, (r) => r.session_id)) med.set(s, median(rs.map((r) => Math.log(r.read_ms))));
  const items = main.map((r) => ({ isC: r.prompt_id === challenger, correct: correct(r), lrt: Math.log(r.read_ms) - med.get(r.session_id), lang: r.first_language ?? null }));

  const rand = seededRandom(seed);
  function boot(xs) {
    const c = xs.filter((x) => x.isC);
    const g = xs.filter((x) => !x.isC);
    if (!c.length || !g.length) return null;
    let faster = 0, worse = 0;
    const draw = (arr, f) => {
      let sw = 0, s = 0;
      for (const x of arr) {
        const w = -Math.log(1 - rand());
        sw += w;
        s += w * f(x);
      }
      return s / sw;
    };
    for (let b = 0; b < o.samples; b++) {
      const acc = draw(c, (x) => x.correct) - draw(g, (x) => x.correct);
      const time = draw(c, (x) => x.lrt) - draw(g, (x) => x.lrt);
      if (time < 0) faster++;
      if (acc < -o.worseMargin) worse++;
    }
    return {
      accuracyDiff: mean(c.map((x) => x.correct)) - mean(g.map((x) => x.correct)),
      timeDiff: mean(c.map((x) => x.lrt)) - mean(g.map((x) => x.lrt)),
      pFaster: faster / o.samples,
      pClearlyWorse: worse / o.samples,
    };
  }

  const nG = items.filter((x) => !x.isC).length;
  const nC = items.filter((x) => x.isC).length;
  const all = boot(items);
  const nonNative = items.filter((x) => x.lang === "no");
  const sub = nonNative.length >= o.subgroupMin ? boot(nonNative) : null;

  const numbers = {
    answers: { golden: nG, challenger: nC },
    accuracy: { golden: nG ? mean(items.filter((x) => !x.isC).map((x) => x.correct)) : null, challenger: nC ? mean(items.filter((x) => x.isC).map((x) => x.correct)) : null },
    quizzes: med.size,
    excluded: { tooGuessable: [...tooGuessable], junkQuizzes: junk.size },
    all,
    nonNative: sub,
  };

  let outcome, reason;
  if (nG < o.minAnswers || nC < o.minAnswers || !all) {
    outcome = "thin";
    reason = `Not enough evidence: ${nC} challenger and ${nG} golden answers (needs ${o.minAnswers} each).`;
  } else {
    const faster = all.pFaster >= o.fasterConfidence;
    const worse = all.pClearlyWorse >= o.worseConfidence;
    const subWorse = sub && sub.pClearlyWorse >= o.worseConfidence;
    outcome = faster && !worse && !subWorse ? "win" : "lose";
    reason = `Readers ${describe(all.accuracyDiff, all.timeDiff)} than golden. ${pct(all.pFaster)} chance it was faster (needs ${pct(o.fasterConfidence)}); ${pct(all.pClearlyWorse)} chance accuracy fell more than ${o.worseMargin * 100} points (must stay under ${pct(o.worseConfidence)}).`;
    if (subWorse) reason += ` Readers whose first language isn't English ${describe(sub.accuracyDiff, sub.timeDiff)}, so it doesn't help everyone.`;
  }
  return { outcome, reason, numbers };
}
