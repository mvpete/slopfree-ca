import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Where prompts/, content/ and evals/ live. Overridable so dry runs don't touch the repo.
export const ROOT = process.env.SLOPFREE_ROOT ? path.resolve(process.env.SLOPFREE_ROOT) : REPO;

const int = (v) => (v === undefined || v === "" ? undefined : Number.parseInt(v, 10));
const num = (v) => (v === undefined || v === "" ? undefined : Number(v));

// FNV-1a: a stable number from a string, for deterministic choices.
export function hashSeed(s) {
  let h = 0x811c9dc5;
  for (const c of String(s)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// One writer per run, picked from the seed (the run date by default). Its judge and answer key come
// from the other model family. WRITER=<name> forces one.
export function pickWriter(writers, seed, forced) {
  if (forced) {
    const w = writers.find((x) => x.name === forced);
    if (!w) throw new Error(`WRITER=${forced} is not one of: ${writers.map((x) => x.name).join(", ")}`);
    return { writer: w, pick: { method: "forced", seed: null, name: w.name, from: writers.map((x) => x.name) } };
  }
  const w = writers[hashSeed(seed) % writers.length];
  return { writer: w, pick: { method: "seeded", seed: String(seed), name: w.name, from: writers.map((x) => x.name) } };
}

// A writer family and everything that grades it. The judge, screen judge and answer key always come
// from the other family: cfg.roles["claude-writer"] is graded by "gpt-judge", and so on.
export function writerSetup(roles, families, name) {
  const other = families.find((f) => f !== name);
  if (!other) throw new Error(`Need a second model family to judge "${name}"`);
  const role = (key) => {
    const r = roles[key];
    if (!r?.model) throw new Error(`slopfree.config.json roles is missing "${key}"`);
    return { model: r.model, effort: r.effort ?? null, role: key };
  };
  const w = role(`${name}-writer`);
  return { name, model: w.model, effort: w.effort, judge: role(`${other}-judge`), screenJudge: role(`${other}-screen-judge`), keyPoints: role(`${other}-key-points`) };
}

export function loadConfig({ seed = new Date().toISOString().slice(0, 10) } = {}) {
  const raw = JSON.parse(readFileSync(path.join(REPO, "slopfree.config.json"), "utf8"));
  const env = process.env;
  const cfg = structuredClone(raw);

  cfg.articles.search = int(env.ARTICLES) ?? cfg.articles.search;
  cfg.articles.screen = int(env.SCREEN_ARTICLES) ?? cfg.articles.screen;
  cfg.articles.confirm = int(env.CONFIRM_ARTICLES) ?? cfg.articles.confirm;
  cfg.articles.quiz = int(env.QUIZ_ARTICLES) ?? cfg.articles.quiz;
  cfg.search.pool = int(env.POOL) ?? cfg.search.pool;
  cfg.search.finalists = int(env.FINALISTS) ?? cfg.search.finalists;
  cfg.budget.maxUsd = num(env.MAX_USD) ?? cfg.budget.maxUsd;
  cfg.dryRun = env.DRY_RUN === "1";
  // cfg.writerPool: every configured writer. cfg.writers: the one this run uses (a list, so the
  // eval helpers stay writer-agnostic). cfg.writer: that writer.
  const families = cfg.writers; // e.g. ["gpt", "claude"]
  cfg.drafter = { ...cfg.roles.drafter, role: "drafter" };
  cfg.questions = { ...cfg.roles.questions, role: "questions" };
  const setups = families.map((name) => writerSetup(cfg.roles, families, name));
  const { writer, pick } = pickWriter(setups, env.WRITER_SEED || seed, env.WRITER);
  cfg.writerPool = setups;
  cfg.writers = [writer];
  cfg.writer = writer;
  cfg.writerPick = pick;

  // Flat names the smaller scripts and the site still read.
  const list = (f) => [...new Set(cfg.writers.map(f))].join(", ");
  Object.assign(cfg, {
    writerModel: list((w) => w.model),
    judgeModel: list((w) => w.judge.model),
    screenJudgeModel: list((w) => w.screenJudge.model),
    drafterModel: cfg.drafter.model,
    questionModel: cfg.questions.model,
    quizArticles: cfg.articles.quiz,
    maxUsdPerRun: cfg.budget.maxUsd,
    prices: cfg.budget.prices,
  });
  return cfg;
}

// The answer-key model: the writer's, which is from the judge's family.
export const keyPointsFor = (cfg) => cfg.writer.keyPoints;

// What a report records so it can be re-checked later: everything except the derived flat names.
export function configSnapshot(cfg) {
  const { writerModel, judgeModel, screenJudgeModel, drafterModel, questionModel, quizArticles, maxUsdPerRun, prices, writer, ...rest } = cfg;
  return structuredClone(rest);
}
