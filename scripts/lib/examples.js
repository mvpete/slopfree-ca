// Examples page: each published article's plain summary next to the golden (and challenger) summary.
import fs from "node:fs";
import path from "node:path";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const name = (id) => String(Number(String(id).replace(/^p-/, "")));
const pct = (x) => (Number.isFinite(x) ? Math.round(x * 100) + "%" : "n/a");

// Summaries can contain light markdown (bold, headings); show it as clean paragraphs.
function paragraphs(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const t = esc(p.replace(/^#+\s*/gm, "").replace(/\n/g, " ")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      return `<p>${t}</p>`;
    })
    .join("");
}

function column(label, sub, run, base, key) {
  const kept = run.covered.filter((c, i) => c && (!key || key[i])).length;
  const vs = "";
  const claims = run.unsupportedClaims?.length
    ? `<details class="claims"><summary>${run.unsupportedClaims.length} unsupported claim${run.unsupportedClaims.length === 1 ? "" : "s"}</summary><ul>${run.unsupportedClaims.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></details>`
    : `<p class="claims none">No unsupported claims</p>`;
  return `<div class="ex-col">
          <h3>${label}${sub ? ` <span class="ex-sub">${sub}</span>` : ""}</h3>
          <p class="ex-stats"><span><strong>${run.words}</strong> words</span><span><strong>${kept}</strong> key points</span><span><strong>${run.unsupported}</strong> unsupported</span>${run.dashes ? `<span><strong>${run.dashes}</strong> em dashes</span>` : ""}${vs}</p>
          <div class="ex-text">${paragraphs(run.summary)}</div>
          ${claims}
        </div>`;
}

export function buildExamples(root, model, golden, challenger, slugs, meta) {
  const read = (rel) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    } catch {
      return null;
    }
  };
  const items = [];
  const totals = { plain: { w: 0, p: 0, u: 0 }, golden: { w: 0, p: 0, u: 0 }, challenger: { w: 0, p: 0, u: 0 } };
  const add = (t, r) => { t.w += r.words; t.p += r.covered.filter(Boolean).length; t.u += r.unsupported; };

  for (const slug of slugs) {
    const dir = `content/articles/${slug}`;
    const base = read(`${dir}/baseline.json`);
    const g = read(`${dir}/${model}/${golden.id}.json`);
    const c = challenger ? read(`${dir}/${model}/${challenger}.json`) : null;
    const src = read(`${dir}/source.json`);
    const pts = read(`${dir}/points.json`);
    if (!base || !g?.covered || !src) continue; // quiz-only articles have no baseline or grading
    add(totals.plain, base);
    add(totals.golden, g);
    if (c?.covered) add(totals.challenger, c);
    items.push({ ratio: g.words / base.words, html: `      <article class="example" aria-roledescription="slide">
        <header class="ex-head">
          <h2><a href="${esc(src.url)}">${esc(src.title)}</a></h2>
          <p>${src.words.toLocaleString()} words · ${pts ? (pts.key ? `${pts.key.filter(Boolean).length} key of ${pts.points.length} points` : `${pts.points.length} points`) : "?"}</p>
        </header>
        <div class="ex-cols${c?.covered ? " three" : ""}">
        ${column("Plain", "", base, null, pts?.key)}
        ${column(`Golden ${name(golden.id)}`, "", g, base, pts?.key)}
        ${c?.covered ? column(`Challenger ${name(challenger)}`, "", c, base, pts?.key) : ""}
        </div>
      </article>` });
  }

  // Show two typical examples: the articles whose golden-vs-plain length change is closest to the median.
  const sorted = [...items].sort((a, b) => a.ratio - b.ratio);
  const mid = (sorted.length - 1) / 2;
  const shown = sorted
    .map((it, i) => ({ ...it, d: Math.abs(i - mid) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2);
  const slides = shown.map((s) => s.html).join("\n");
  const dots = shown.map((_, i) => `<button class="car-dot" type="button" aria-label="Example ${i + 1}"${i === 0 ? ' aria-current="true"' : ""}></button>`).join("");
  const carousel = shown.length
    ? `<div class="carousel" aria-roledescription="carousel" aria-label="Examples">
      <div class="car-track" id="car-track">
${slides}
      </div>
      ${shown.length > 1 ? `<div class="car-nav"><button class="car-btn" type="button" id="car-prev" aria-label="Previous example">←</button><span class="car-dots">${dots}</span><button class="car-btn" type="button" id="car-next" aria-label="Next example">→</button></div>` : ""}
    </div>`
    : "";

  const row = (label, t) => (t.w ? `<tr><td>${label}</td><td>${t.w.toLocaleString()}</td><td>${t.p}</td><td>${t.u}</td></tr>` : "");
  const summary = items.length
    ? `<table class="models-table ex-totals">
          <thead><tr><th>Across ${items.length} articles</th><th>Words</th><th>Points kept</th><th>Unsupported</th></tr></thead>
          <tbody>
            ${row("Plain summary", totals.plain)}
            ${row(`Golden, prompt ${name(golden.id)}`, totals.golden)}
            ${row(challenger ? `Challenger, prompt ${name(challenger)}` : "", totals.challenger)}
          </tbody>
        </table>`
    : `<p class="lede">No examples yet. They appear after the first weekly eval publishes its articles.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Slopfree Examples</title>
  <meta name="description" content="Real Wikipedia articles summarized by a plain prompt and by the golden prompt, side by side, with words, points kept and unsupported claims.">
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <meta name="theme-color" content="#34302A">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/styles.css">
</head>
<body class="page-examples">
  <header class="topbar">
    <a class="wordmark" href="./">slopfree<span>.ca</span></a>
    ${meta.nav}
  </header>
  <main class="examples-main">
    <div class="wrap">
      <p class="eyebrow">Examples</p>
      <h1 class="ex-title">Golden simplification.</h1>
      <p class="small">${meta.date ? `Eval of ${esc(meta.date)}. ` : ""}Summaries by <code>${esc(meta.writer)}</code>, judged by <code>${esc(meta.judge)}</code>.</p>
    </div>
    <div class="wrap examples">
    ${carousel}
    </div>
  </main>
  <footer class="footer">
    <span class="made">Proudly made in Canada <span class="leaf" role="img" aria-label="maple leaf">🍁</span> with imported AI</span>
    <span>Code MIT · content CC BY-SA 4.0 from Wikipedia</span>
    <a href="https://github.com/mvpete/slopfree-ca">GitHub</a>
  </footer>
  <script>
    (function () {
      var track = document.getElementById("car-track");
      if (!track) return;
      var slides = track.children, dots = document.querySelectorAll(".car-dot");
      var at = function () { return Math.round(track.scrollLeft / track.clientWidth); };
      var go = function (i) { i = Math.max(0, Math.min(slides.length - 1, i)); track.scrollTo({ left: i * track.clientWidth, behavior: "smooth" }); };
      var prev = document.getElementById("car-prev"), next = document.getElementById("car-next");
      if (prev) prev.onclick = function () { go(at() - 1); };
      if (next) next.onclick = function () { go(at() + 1); };
      dots.forEach(function (d, i) { d.onclick = function () { go(i); }; });
      track.addEventListener("scroll", function () {
        var i = at();
        dots.forEach(function (d, j) { if (j === i) d.setAttribute("aria-current", "true"); else d.removeAttribute("aria-current"); });
        if (prev) prev.disabled = i === 0;
        if (next) next.disabled = i === slides.length - 1;
      }, { passive: true });
      if (prev) prev.disabled = true;
    })();
  </script>
</body>
</html>
`;
}
