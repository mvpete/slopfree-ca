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

// Phone tabs: one button per column. Hidden on wide screens, where all columns show side by side.
function tabBar(labels) {
  return `<div class="tab-bar" role="tablist">${labels
    .map((l, i) => `<button type="button" class="tab${i === 0 ? " active" : ""}" role="tab" aria-selected="${i === 0}" data-i="${i}">${l}</button>`)
    .join("")}</div>`;
}

function column(label, sub, run, base, key) {
  const kept = run.covered.filter((c, i) => c && (!key || key[i])).length;
  const vs = "";
  return `<div class="ex-col">
          <h3>${label}${sub ? ` <span class="ex-sub">${sub}</span>` : ""}</h3>
          <p class="ex-stats"><span><strong>${run.words}</strong> words</span><span><strong>${kept}</strong> key points</span><span><strong>${run.unsupported}</strong> unsupported claim${run.unsupported === 1 ? "" : "s"}</span>${run.dashes ? `<span><strong>${run.dashes}</strong> em dashes</span>` : ""}${vs}</p>
          <div class="ex-text">${paragraphs(run.summary)}</div>
        </div>`;
}

// Back of the card: every flagged claim, one column per prompt.
function claimsColumn(label, run) {
  const list = run.unsupportedClaims || [];
  return `<div class="ex-col">
          <h3>${label}</h3>
          ${list.length ? `<ul class="claims">${list.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : `<p class="claims none">None flagged.</p>`}
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
    const runs = [["Plain", base], ["Golden", g], ...(c?.covered ? [["Challenger", c]] : [])];
    const three = c?.covered ? " three" : "";
    const head = (flipLabel) => `<header class="ex-head">
          <div>
            <h2><a href="${esc(src.url)}">${esc(src.title)}</a></h2>
            <p>${src.words.toLocaleString()}-word article${pts?.points?.length ? (pts.key?.length ? ` · ${pts.key.filter(Boolean).length} key points of ${pts.points.length} total` : ` · ${pts.points.length} points total`) : ""}</p>
          </div>
          <button class="btn ghost ex-flip" type="button">${flipLabel}</button>
        </header>`;
    items.push({ ratio: g.words / base.words, html: `      <article class="example" aria-roledescription="slide">
        <div class="ex-card">
          <div class="ex-face ex-front">
        ${head("Flip to see unsupported claims")}
        <div class="tabset">
        ${tabBar(runs.map(([label]) => label))}
        <div class="ex-cols${three}">
        ${runs.map(([label, r], i) => column(label, "", r, r === base ? null : base, pts?.key).replace('<div class="ex-col">', `<div class="ex-col tab-panel${i === 0 ? " active" : ""}">`)).join("\n        ")}
        </div>
        </div>
          </div>
          <div class="ex-face ex-back" aria-hidden="true">
        ${head("Back to summaries")}
        <div class="ex-cols${three}">
        ${runs.map(([label, r]) => claimsColumn(label, r)).join("\n        ")}
        </div>
          </div>
        </div>
      </article>` });
  }

  // Show five typical examples: the articles whose golden-vs-plain length change is closest to the median.
  const sorted = [...items].sort((a, b) => a.ratio - b.ratio);
  const mid = (sorted.length - 1) / 2;
  const shown = sorted
    .map((it, i) => ({ ...it, d: Math.abs(i - mid) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5);
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

  // The exact prompts behind each column.
  // One composite score per prompt: net key points (kept minus unsupported claims) per word,
  // as a multiple of the plain summary's. Higher is better; plain is 1.00 by definition.
  const scoreRows = (s) => {
    if (s?.baseline) return `<p class="ex-score">Score: <strong>1.00</strong></p>`;
    const sc = s?.score;
    if (!sc) return "";
    const v = Number.isFinite(sc.composite)
      ? sc.composite
      : (sc.kept - sc.candUnsupported) / sc.candWords / ((sc.baseKept - sc.baseUnsupported) / sc.baseWords);
    return Number.isFinite(v) ? `<p class="ex-score">Score: <strong>${v.toFixed(2)}</strong></p>` : "";
  };
  const box = (label, body, note, s, active) => `<div class="ex-prompt tab-panel${active ? " active" : ""}">
        <h3>${label}</h3>
        <pre>${esc(body)}</pre>${note ? `<p class="small">${note}</p>` : ""}
        ${scoreRows(s, meta.gate)}
      </div>`;
  const promptLabels = ["Plain", "Golden", ...(meta.challengerText ? ["Challenger"] : [])];
  const prompts = `<div class="tabset">
    ${tabBar(promptLabels)}
    <div class="ex-prompts${meta.challengerText ? " three" : ""}">
      ${box("Plain", `${meta.wrapper}\n<article>`, "The baseline every score is measured against.", { baseline: true }, true)}
      ${box("Golden", `${meta.wrapper}\n<article>\n\n${golden.text}`, "", meta.scores?.golden)}
      ${meta.challengerText ? box("Challenger", `${meta.wrapper}\n<article>\n\n${meta.challengerText}`, "", meta.scores?.challenger) : ""}
    </div>
    </div>`;

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
    ${prompts}
    ${carousel}
    </div>
  </main>
  <footer class="footer">
    <span class="made">Proudly made in Canada <span class="leaf" role="img" aria-label="maple leaf">🍁</span> Contains natural and artificial intelligence.</span>
    <span>Code MIT · content CC BY-SA 4.0 from Wikipedia</span>
    <a href="https://github.com/mvpete/slopfree-ca">GitHub</a>
  </footer>
  <script>
    (function () {
      var track = document.getElementById("car-track");
      if (!track) return;
      var slides = track.children, dots = document.querySelectorAll(".car-dot");
      // One slide's step includes the gap between slides.
      var step = function () { return slides.length > 1 ? slides[1].offsetLeft - slides[0].offsetLeft : track.clientWidth; };
      var at = function () { return Math.max(0, Math.min(slides.length - 1, Math.round(track.scrollLeft / step()))); };
      var go = function (i) { i = Math.max(0, Math.min(slides.length - 1, i)); track.scrollTo({ left: i * step(), behavior: "smooth" }); };
      // The carousel is as tall as the slide on screen, not the tallest slide.
      var fit = function () {
        var card = slides[at()].querySelector(".ex-card");
        // Both faces share one grid cell, so the card is as tall as its taller face and keeps that size when flipped.
        track.style.height = (card ? card.offsetHeight : slides[at()].offsetHeight) + "px";
      };
      var prev = document.getElementById("car-prev"), next = document.getElementById("car-next");
      if (prev) prev.onclick = function () { go(at() - 1); };
      if (next) next.onclick = function () { go(at() + 1); };
      dots.forEach(function (d, i) { d.onclick = function () { go(i); }; });
      track.addEventListener("scroll", function () {
        var i = at();
        dots.forEach(function (d, j) { if (j === i) d.setAttribute("aria-current", "true"); else d.removeAttribute("aria-current"); });
        if (prev) prev.disabled = i === 0;
        if (next) next.disabled = i === slides.length - 1;
        fit();
      }, { passive: true });
      window.addEventListener("resize", fit);
      window.addEventListener("load", fit);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
      // Re-measure whenever any card face changes size (fonts loading, wrapping, flipping).
      if (window.ResizeObserver) {
        var ro = new ResizeObserver(fit);
        track.querySelectorAll(".ex-face").forEach(function (f) { ro.observe(f); });
      }
      document.querySelectorAll(".tabset").forEach(function (set) {
        var tabs = set.querySelectorAll(".tab"), panels = set.querySelectorAll(".tab-panel");
        tabs.forEach(function (t) {
          t.onclick = function () {
            var i = Number(t.dataset.i);
            tabs.forEach(function (x, j) { x.classList.toggle("active", j === i); x.setAttribute("aria-selected", j === i ? "true" : "false"); });
            panels.forEach(function (p, j) { p.classList.toggle("active", j === i); });
            fit();
          };
        });
      });
      document.querySelectorAll(".ex-flip").forEach(function (b) {
        b.onclick = function () {
          var card = b.closest(".ex-card");
          var flipped = card.classList.toggle("flipped");
          card.querySelector(".ex-front").setAttribute("aria-hidden", flipped ? "true" : "false");
          card.querySelector(".ex-back").setAttribute("aria-hidden", flipped ? "false" : "true");
          var other = card.querySelector(flipped ? ".ex-back .ex-flip" : ".ex-front .ex-flip");
          if (other) other.focus({ preventScroll: true });
          fit();
        };
      });
      if (prev) prev.disabled = true;
      fit();
    })();
  </script>
</body>
</html>
`;
}
