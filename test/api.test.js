import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResults, HttpError } from "../api/src/validate.js";

const ok = {
  model: "openai",
  firstLanguage: "no",
  token: "t",
  answers: [{ promptId: "p-0001", slug: "halifax-explosion", choice: 1, readMs: 30000, words: 210, round: 1, guess: false, hidden: false }],
};
const opts = { models: ["openai"] };
const rejects = (body, re) =>
  assert.throws(() => validateResults(body, opts), (e) => e instanceof HttpError && e.status === 400 && re.test(e.message));

test("accepts a valid body", () => {
  const v = validateResults(ok, opts);
  assert.equal(v.answers[0].slug, "halifax-explosion");
  assert.equal(v.firstLanguage, "no");
});

test("rejects unknown models and bad fields", () => {
  rejects({ ...ok, model: "gpt" }, /model/);
  rejects({ ...ok, firstLanguage: "maybe" }, /firstLanguage/);
  rejects({ ...ok, answers: [] }, /1 to 10/);
  rejects({ ...ok, answers: [{ ...ok.answers[0], choice: 5 }] }, /choice/);
  rejects({ ...ok, answers: [{ ...ok.answers[0], slug: "../etc" }] }, /slug/);
  rejects({ ...ok, answers: [{ ...ok.answers[0], promptId: "golden" }] }, /promptId/);
});

test("accepts too hard as choice 4", () => {
  assert.equal(validateResults({ ...ok, answers: [{ ...ok.answers[0], choice: 4 }] }, opts).answers[0].choice, 4);
});

test("strips unknown fields such as a client-claimed 'correct'", () => {
  const v = validateResults({ ...ok, answers: [{ ...ok.answers[0], correct: true }] }, opts);
  assert.equal("correct" in v.answers[0], false);
});
