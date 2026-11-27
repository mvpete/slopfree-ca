import { test } from "node:test";
import assert from "node:assert/strict";
import { createBudget, BudgetExceeded } from "../scripts/lib/llm.js";

const PRICES = { big: { input: 2, output: 10 }, small: { input: 0.1, output: 0.5 } };

test("counts dollars per model", () => {
  const b = createBudget(2, PRICES);
  b.add(0, "big", 100_000, 10_000); // $0.20 + $0.10
  b.add(0, "small", 1_000_000, 0); // $0.10
  assert.equal(b.usd.toFixed(2), "0.40");
  assert.equal(b.byModel.big.usd.toFixed(2), "0.30");
  assert.equal(b.left.toFixed(2), "1.60");
});

test("stops hard once the cap is passed", () => {
  const b = createBudget(1, PRICES);
  b.add(0, "big", 400_000, 0); // $0.80
  assert.throws(() => b.add(0, "big", 0, 30_000), BudgetExceeded); // +$0.30
});

test("a model with no price is charged at the dearest known price", () => {
  const b = createBudget(5, PRICES);
  b.add(0, "typo-model", 1_000_000, 0);
  assert.equal(b.usd, 2);
});

test("cached input is cheap to read and a bit dearer to write", () => {
  const b = createBudget(5, PRICES);
  b.add(0, "big", 0, 0, { cacheWrite: 1_000_000 }); // $2.50
  b.add(0, "big", 0, 0, { cacheRead: 1_000_000 }); // $0.20
  assert.equal(b.usd.toFixed(2), "2.70");
  assert.equal(b.byModel.big.cachedInput, 1_000_000);
});
