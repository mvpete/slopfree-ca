import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Where prompts/, content/ and evals/ live. Overridable so dry runs don't touch the repo.
export const ROOT = process.env.SLOPFREE_ROOT ? path.resolve(process.env.SLOPFREE_ROOT) : REPO;

const int = (v) => (v === undefined || v === "" ? undefined : Number.parseInt(v, 10));

export function loadConfig() {
  const cfg = JSON.parse(readFileSync(path.join(REPO, "slopfree.config.json"), "utf8"));
  const env = process.env;
  return {
    ...cfg,
    writerModel: env.WRITER_MODEL || cfg.writerModel,
    judgeModel: env.JUDGE_MODEL || cfg.judgeModel,
    drafterModel: env.DRAFTER_MODEL || cfg.drafterModel || cfg.judgeModel,
    questionModel: env.QUESTION_MODEL || cfg.questionModel || cfg.judgeModel,
    articles: int(env.ARTICLES) ?? cfg.articles,
    screenArticles: int(env.SCREEN_ARTICLES) ?? cfg.screenArticles,
    quizArticles: int(env.QUIZ_ARTICLES) ?? cfg.quizArticles,
    maxAttempts: int(env.MAX_ATTEMPTS) ?? cfg.maxAttempts,
    maxTokensPerRun: int(env.MAX_TOKENS) ?? cfg.maxTokensPerRun,
    dryRun: env.DRY_RUN === "1",
  };
}
