// "Models used" table on the site, generated from slopfree.config.json so it can't drift.
const ROWS = [
  ["writerModel", "Writes the summaries"],
  ["judgeModel", "Judges which points were kept"],
  ["drafterModel", "Drafts new candidate prompts"],
  ["questionModel", "Writes the quiz questions from the summaries"],
];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderModels(cfg) {
  const rows = ROWS.map(([k, job]) => `            <tr><td>${job}</td><td><code>${esc(cfg[k] || cfg.judgeModel)}</code></td></tr>`).join("\n");
  return `<table class="models-table">
          <thead><tr><th>Job</th><th>Model</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>`;
}

const START = "<!-- models:start -->";
const END = "<!-- models:end -->";
export function injectModels(html, cfg) {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error("index.html is missing the models markers");
  return html.slice(0, a + START.length) + "\n        " + renderModels(cfg) + "\n        " + html.slice(b);
}
