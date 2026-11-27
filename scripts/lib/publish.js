// Mandatory checks before a summary reaches readers (cfg.publication):
//   unsupported { max }  claims the article doesn't back, graded by the other model family
//   moderation           OpenAI's moderation check on the summary text
// An article is published only if every prompt's summary of it passes. Summaries that were already
// graded by the main judge reuse that grading; the rest are graded by the screen judge (or the main
// judge with publication.judge = "judge").
import { pool } from "./util.js";
import { BudgetExceeded } from "./llm.js";

// entries: [{ promptId, runs }] where runs line up with articles. Returns which articles pass and why.
export async function publicationChecks(ctx, articles, entries) {
  const { cfg, tasks, log } = ctx;
  const pub = cfg.publication || {};
  const checker = pub.judge === "judge" ? cfg.writer.judge : cfg.writer.screenJudge;
  const results = await pool(articles, cfg.concurrency, async (a, i) => {
    const checks = [];
    for (const { promptId, runs } of entries) {
      const r = runs[i];
      let unsupported = r.unsupported;
      let claims = r.unsupportedClaims;
      let by = r.covered ? "judge" : null;
      if (pub.unsupported && unsupported === undefined) {
        const j = await tasks.judge(a, a.points || [], r.summary, { ...checker, role: "publication" });
        unsupported = j.unsupported;
        claims = j.unsupportedClaims;
        by = checker.model;
      }
      let flagged = false;
      if (pub.moderation) {
        try {
          flagged = await tasks.moderate(r.summary);
        } catch (e) {
          if (e instanceof BudgetExceeded) throw e;
          flagged = null;
        }
      }
      const problems = [];
      if (pub.unsupported && unsupported > pub.unsupported.max) problems.push(`${unsupported} unsupported claim${unsupported === 1 ? "" : "s"}`);
      if (flagged === true) problems.push("flagged by moderation");
      if (flagged === null) problems.push("moderation check failed");
      checks.push({ prompt: promptId, unsupported, unsupportedClaims: claims, gradedBy: by, flagged, problems });
    }
    return { slug: a.slug, title: a.source.title, revision: a.source.revision, checks, pass: checks.every((c) => !c.problems.length) };
  });
  for (const r of results.filter((x) => !x.pass)) log(`left out ${r.slug}: ${r.checks.flatMap((c) => c.problems.map((p) => `${c.prompt} ${p}`)).join("; ")}`);
  return { passing: articles.filter((_, i) => results[i].pass), results, checker, rules: pub };
}
