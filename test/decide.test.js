import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, seededRandom } from "../scripts/lib/decide.js";

const key = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`a${i}`, 0]));

// One reader, quizzes of 5 rounds, each article seen once. About 25 answers = 5 quizzes.
export function simulate({ quizzes = 5, accG = 0.75, accC = 0.75, timeC = 0.77, noise = 0.35, lang = "yes", seed = "sim" }) {
  const rand = seededRandom(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const rows = [];
  let article = 0;
  for (let s = 0; s < quizzes; s++) {
    const day = Math.exp(gauss() * 0.15); // some days you read slower
    for (let i = 0; i < 5; i++) {
      const isC = (i + s) % 2 === 1;
      rows.push({
        session_id: `${seed}-q${s}`,
        prompt_id: isC ? "p-0002" : "p-0001",
        slug: `a${article++ % 40}`,
        choice: rand() < (isC ? accC : accG) ? 0 : 1 + Math.floor(rand() * 3),
        read_ms: Math.round(45000 * day * (isC ? timeC : 1) * Math.exp(gauss() * noise)),
        words: isC ? 190 : 250,
        guess: false,
        hidden: false,
        first_language: lang,
      });
    }
  }
  return rows;
}

const run = (rows, extra = {}) => decide(rows, { golden: "p-0001", challenger: "p-0002", key, seed: "test", ...extra });

// Over many simulated weeks, how often does each case win?
export function winRate(opts, weeks = 200) {
  let wins = 0;
  for (let w = 0; w < weeks; w++) if (run(simulate({ ...opts, seed: "w" + w })).outcome === "win") wins++;
  return wins / weeks;
}

test("a faster challenger with the same accuracy usually wins in a 25-answer week", () => {
  const r = winRate({});
  assert.ok(r >= 0.5, `win rate ${r}`);
});

test("a challenger that isn't faster rarely wins", () => {
  const r = winRate({ timeC: 1.0 });
  assert.ok(r <= 0.2, `win rate ${r}`);
});

test("a clearly less accurate challenger rarely wins, even when faster", () => {
  const r = winRate({ accC: 0.4 });
  assert.ok(r <= 0.2, `win rate ${r}`);
});

test("under 10 answers per prompt is a thin week", () => {
  const r = run(simulate({ quizzes: 3 }));
  assert.equal(r.outcome, "thin");
  assert.match(r.reason, /Not enough evidence/);
});

test("same inputs and seed give the same verdict", () => {
  const rows = simulate({});
  assert.deepEqual(run(rows), run(rows));
});

test("answers to a replaced question don't count", () => {
  const rows = simulate({}).map((r) => ({ ...r, qid: "aaaaaaaa" }));
  const qids = Object.fromEntries(Object.keys(key).map((s) => [s, "aaaaaaaa"]));
  const total = (r) => r.numbers.answers.golden + r.numbers.answers.challenger;
  const n = total(run(rows, { qids }));
  assert.ok(n > 0);
  qids.a0 = "bbbbbbbb"; // article a0's question was rewritten
  assert.equal(total(run(rows, { qids })), n - 1);
});

test("impossibly fast reads and hidden tabs are dropped", () => {
  const rows = simulate({});
  const n = run(rows).numbers.answers.challenger;
  rows.push({ ...rows[1], read_ms: 100 }, { ...rows[1], hidden: true });
  assert.equal(run(rows).numbers.answers.challenger, n);
});
