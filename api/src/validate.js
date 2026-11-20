export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => {
  throw new HttpError(400, msg);
};
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Check and normalize a POST /v1/results body.
export function validateResults(body, { models }) {
  if (!body || typeof body !== "object") bad("Body must be a JSON object.");
  const { model, firstLanguage = null, token = null, answers } = body;
  if (!models.includes(model)) bad("Unknown model.");
  if (![null, "yes", "no"].includes(firstLanguage)) bad("firstLanguage must be yes, no or null.");
  if (token !== null && (typeof token !== "string" || token.length > 4096)) bad("Bad token.");
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 10) bad("answers must have 1 to 10 rounds.");

  return {
    model,
    firstLanguage,
    token,
    answers: answers.map((a, i) => {
      if (!a || typeof a !== "object") bad(`Round ${i + 1} is not an object.`);
      if (typeof a.promptId !== "string" || !/^p-\d{4,}$/.test(a.promptId)) bad(`Round ${i + 1}: bad promptId.`);
      if (typeof a.slug !== "string" || !/^[a-z0-9-]{1,80}$/.test(a.slug)) bad(`Round ${i + 1}: bad slug.`);
      if (!isInt(a.choice, 0, 4)) bad(`Round ${i + 1}: choice must be 0 to 3, or 4 for too hard.`);
      if (!isInt(a.readMs, 0, 3600000)) bad(`Round ${i + 1}: bad readMs.`);
      if (!isInt(a.words, 0, 5000)) bad(`Round ${i + 1}: bad words.`);
      if (!isInt(a.round, 1, 10)) bad(`Round ${i + 1}: bad round.`);
      return {
        promptId: a.promptId,
        slug: a.slug,
        choice: a.choice,
        readMs: a.readMs,
        words: a.words,
        round: a.round,
        guess: a.guess === true,
        hidden: a.hidden === true,
      };
    }),
  };
}
