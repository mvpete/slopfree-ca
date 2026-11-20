import { test } from "node:test";
import assert from "node:assert/strict";
import { articleStats, score, checkGate } from "../scripts/lib/gate.js";

const GATE = { coverage: 0.98, floor: 0.9, lengthRatio: 0.8 };
const base = { covered: [true, true, true, true, true, true, true, true, true, true, false], unsupported: 1, words: 300 };
const cand = (over = {}) => ({ covered: [...base.covered], unsupported: 1, words: 200, ...over });
const run = (cands) => checkGate(score(cands.map((c, i) => articleStats("a" + i, base, c))), GATE);

test("a candidate can keep different points than the baseline", () => {
  // Baseline kept points 0-9. This candidate drops point 0 but keeps point 10 instead: same count.
  const s = articleStats("x", base, cand({ covered: [false, true, true, true, true, true, true, true, true, true, true] }));
  assert.equal(s.baseCovered, 10);
  assert.equal(s.kept, 10);
  assert.equal(s.overlap, 9);
  assert.equal(checkGate(score([s]), GATE).passed, true);
});

test("passes: same coverage, a third shorter, no extra errors", () => {
  const r = run(Array.from({ length: 5 }, () => cand()));
  assert.equal(r.passed, true);
  assert.equal(r.distance, 0);
});

test("fails coverage when points are dropped", () => {
  const dropped = cand({ covered: [false, true, true, true, true, true, true, true, true, true, false] });
  const r = run([dropped, dropped, cand(), cand(), cand()]);
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f.check === "coverage"));
});

test("fails floor when one article loses a lot", () => {
  const bad = cand({ covered: [false, false, true, true, true, true, true, true, true, true, false] });
  const r = run([bad, ...Array.from({ length: 19 }, () => cand())]);
  assert.ok(r.failures.some((f) => f.check === "floor"));
  assert.ok(!r.failures.some((f) => f.check === "coverage"), "99% overall still clears 98%");
});

test("fails length when under 20% shorter", () => {
  const r = run(Array.from({ length: 3 }, () => cand({ words: 270 })));
  assert.deepEqual(r.failures.map((f) => f.check), ["length"]);
  assert.match(r.failures[0].message, /Only 10\.0% shorter/);
});

test("exactly 20% shorter passes", () => {
  assert.equal(run([cand({ words: 240 })]).passed, true);
});

test("fails accuracy with more unsupported claims than baseline", () => {
  const r = run([cand({ unsupported: 3 })]);
  assert.deepEqual(r.failures.map((f) => f.check), ["accuracy"]);
});

test("closer misses rank ahead of worse ones", () => {
  const near = run([cand({ words: 250 })]);
  const far = run([cand({ words: 300, covered: base.covered.map(() => false) })]);
  assert.ok(near.distance < far.distance);
});
