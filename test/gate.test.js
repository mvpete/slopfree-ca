import { test } from "node:test";
import assert from "node:assert/strict";
import { articleStats, score, checkGate } from "../scripts/lib/gate.js";

const GATE = { coverage: 0.95, floor: 0.85, efficiency: 0.15 };
// 10 points: 0-4 key, 5-9 detail. The plain summary keeps all 10 in 300 words.
const weights = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const all = Array(10).fill(true);
const base = { covered: all, unsupported: 1, words: 300 };
const cand = (over = {}) => ({ covered: all, unsupported: 1, words: 240, ...over });
const stats = (c) => articleStats("a", base, c, 3000, weights);
const run = (cands) => checkGate(score(cands.map((c, i) => articleStats("a" + i, base, c, 3000, weights))), GATE);
const keyOnly = [true, true, true, true, true, false, false, false, false, false];

test("detail points are worth nothing; key points count", () => {
  const s = stats(cand({ covered: keyOnly }));
  assert.equal(s.baseCovered, 5);
  assert.equal(s.kept, 5);
  assert.equal(s.keyPoints, 5);
});

test("dropping the trivia and the words it took passes", () => {
  // Same 5 key points in 150 words instead of 300: twice the key points per word.
  const r = run([cand({ covered: keyOnly, words: 150 })]);
  assert.equal(r.passed, true, r.failures.map((f) => f.message).join(" "));
  assert.equal(r.distance, 0);
});

test("padding with trivia doesn't help: same length, same key points, fails efficiency", () => {
  const r = run([cand({ words: 300 })]);
  assert.deepEqual(r.failures.map((f) => f.check), ["efficiency"]);
});

test("15% fewer words with the same key points is exactly enough", () => {
  assert.equal(run([cand({ words: 255 })]).passed, true);
  assert.equal(run([cand({ words: 260 })]).passed, false);
});

test("losing key points fails accuracy even when short", () => {
  const lost = [true, true, true, true, false, true, true, true, true, true]; // 4 of 5 key points
  const r = run([cand({ covered: lost, words: 100 })]);
  assert.ok(r.failures.some((f) => f.check === "coverage"));
});

test("a candidate can keep different points than the baseline", () => {
  const b = { covered: [true, true, true, true, false, false, false, false, false, false], unsupported: 0, words: 200 };
  const c = { covered: [false, true, true, true, true, false, false, false, false, false], unsupported: 0, words: 150 };
  const s = articleStats("x", b, c, 3000, weights);
  assert.equal(s.kept, 4);
  assert.equal(s.overlap, 3);
  assert.equal(checkGate(score([s]), GATE).passed, true);
});

test("one article losing too much fails the floor", () => {
  const bad = cand({ covered: [true, true, true, false, false, false, false, false, false, false], words: 100 });
  const r = run([bad, ...Array.from({ length: 19 }, () => cand({ covered: keyOnly, words: 150 }))]);
  assert.ok(r.failures.some((f) => f.check === "floor"));
});

test("more unsupported claims than the baseline fails", () => {
  const r = run([cand({ covered: keyOnly, words: 150, unsupported: 3 })]);
  assert.deepEqual(r.failures.map((f) => f.check), ["accuracy"]);
});

test("older data without labels counts every point", () => {
  const s = articleStats("x", base, cand(), 3000, null);
  assert.equal(s.baseCovered, 10);
});

test("closer misses rank ahead of worse ones", () => {
  const near = run([cand({ words: 270 })]);
  const far = run([cand({ words: 400, covered: Array(10).fill(false) })]);
  assert.ok(near.distance < far.distance);
});

test("any em dash fails, even when everything else passes", () => {
  const r = run([cand({ covered: keyOnly, words: 150, dashes: 1 })]);
  assert.deepEqual(r.failures.map((f) => f.check), ["dashes"]);
});

test("more literary flourishes than the plain summary fails", () => {
  const b = { ...base, style: 1 };
  const s = articleStats("x", b, { covered: keyOnly, unsupported: 1, words: 150, style: 3 }, 3000, weights);
  assert.deepEqual(checkGate(score([s]), GATE).failures.map((f) => f.check), ["style"]);
});

// Weekly gate: the challenger against golden, on net key points per word.
const VS_GOLDEN = { vs: "golden", coverage: 0.95, margin: 0.05 };
const goldenRun = { covered: keyOnly, unsupported: 0, words: 200, dashes: 0, style: 0 };
const vsGolden = (c) => checkGate(score([articleStats("a", goldenRun, { dashes: 0, style: 0, unsupported: 0, ...c }, 3000, weights)]), VS_GOLDEN);

test("vs golden: same key points in fewer words passes", () => {
  const r = vsGolden({ covered: keyOnly, words: 180 }); // 1.11x
  assert.equal(r.passed, true, r.failures.map((f) => f.message).join(" "));
});

test("vs golden: a tie isn't enough, it has to win by the margin", () => {
  const r = vsGolden({ covered: keyOnly, words: 200 });
  assert.deepEqual(r.failures.map((f) => f.check), ["margin"]);
  assert.match(r.failures[0].message, /golden's/);
});

test("vs golden: made-up claims count against the margin and the accuracy check", () => {
  // Same words and points, one extra unsupported claim: net points drop from 5 to 4.
  const r = vsGolden({ covered: keyOnly, words: 180, unsupported: 1 });
  assert.deepEqual(r.failures.map((f) => f.check).sort(), ["accuracy", "margin"]);
});

test("vs golden: much shorter but losing key points fails coverage", () => {
  const lost = [true, true, true, false, false, false, false, false, false, false];
  const r = vsGolden({ covered: lost, words: 60 });
  assert.ok(r.failures.some((f) => f.check === "coverage"));
});

test("one weak article no longer sinks an otherwise clear winner", () => {
  // 60% of golden's key points on one article: the old 85% floor failed this. 48 of 50 overall.
  const weak = articleStats("weak", goldenRun, { covered: [true, true, true, false, false, false, false, false, false, false], unsupported: 0, words: 100 }, 3000, weights);
  const good = Array.from({ length: 9 }, (_, i) => articleStats("g" + i, goldenRun, { covered: keyOnly, unsupported: 0, words: 150 }, 3000, weights));
  const r = checkGate(score([weak, ...good]), VS_GOLDEN);
  assert.equal(r.passed, true, r.failures.map((f) => f.message).join(" "));
});

test("older reports with floor and efficiency still re-check the old way", () => {
  assert.equal(run([cand({ words: 300 })]).failures[0].check, "efficiency");
});
