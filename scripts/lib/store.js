// Files under ROOT: prompts/, content/, evals/.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { pct, promptName } from "./util.js";

const abs = (rel) => path.join(ROOT, rel);

export function readJSON(rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(abs(rel), "utf8"));
  } catch (e) {
    if (fallback !== undefined && e.code === "ENOENT") return fallback;
    throw e;
  }
}

export function writeText(rel, text) {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text.endsWith("\n") ? text : text + "\n");
}

export const writeJSON = (rel, data) => writeText(rel, JSON.stringify(data, null, 2));
export const readText = (rel) => fs.readFileSync(abs(rel), "utf8");

export function readGolden(model) {
  const { id } = readJSON(`prompts/${model}/golden.json`);
  return { id, text: readText(`prompts/${model}/${id}.md`).trim() };
}

export function nextPromptId(model) {
  const ids = [];
  for (const dir of [`prompts/${model}`, `prompts/${model}/losers`]) {
    if (!fs.existsSync(abs(dir))) continue;
    for (const f of fs.readdirSync(abs(dir))) {
      const m = f.match(/^p-(\d+)\.md$/);
      if (m) ids.push(Number(m[1]));
    }
  }
  return "p-" + String(Math.max(0, ...ids) + 1).padStart(4, "0");
}

export function existingSlugs() {
  const dir = abs("content/articles");
  return new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
}

// One file per losing prompt: the prompt, why it lost, and its numbers.
export function writeLoser(model, { id, date, by, stage, reason, score, table, prompt, report, models }) {
  const rows = table
    ? table
    : score
    ? `| Articles | Coverage vs baseline | Worst article | Shorter than baseline | Unsupported (prompt / base) |
|---|---|---|---|---|
| ${score.n} | ${pct(score.coverage)} | ${pct(score.floor)} | ${pct(1 - score.lengthRatio)} | ${score.candUnsupported} / ${score.baseUnsupported} |`
    : "No numbers: it failed before scoring.";
  writeText(
    `prompts/${model}/losers/${id}.md`,
    `# Prompt ${promptName(id)}: close but no cigar

**Date:** ${date}
${by ? `**Submitted by:** @${by}
` : ""}**Lost at:** ${stage}
**Why it lost:** ${reason}

${rows}

${models ? `Summaries by \`${models.writer}\`, judged by \`${models.judge}\`. ` : ""}Full log: \`${report}\`

## Prompt

\`\`\`text
${prompt}
\`\`\`
`
  );
}
