// Human First Design: principles/NN-name.md -> the page section between the principles markers.
import fs from "node:fs";
import path from "node:path";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Small, safe markdown: paragraphs, **bold**, *italic*, [text](https://...).
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export function readPrinciples(root) {
  const dir = path.join(root, "principles");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+-.+\.md$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b))
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n").trim();
      const m = text.match(/^#\s+(.+)\n+([\s\S]*)$/);
      if (!m) throw new Error(`principles/${f} must start with a "# Heading" line`);
      const paras = m[2].split(/\n\s*\n/).map((p) => p.replace(/\n/g, " ").trim()).filter(Boolean);
      return { file: f, title: m[1].trim(), html: paras.map((p) => `<p>${inline(p)}</p>`).join("") };
    });
}

export function renderPrinciples(list) {
  const items = list
    .map((p, i) => `          <li class="principle"><span class="principle-num" aria-hidden="true">${i + 1}</span><h3>${inline(p.title)}</h3><div class="principle-text">${p.html}</div></li>`)
    .join("\n");
  return `<ol class="principles">
${items}
        </ol>`;
}

const START = "<!-- principles:start -->";
const END = "<!-- principles:end -->";

export function injectPrinciples(html, list) {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error("index.html is missing the principles markers");
  return html.slice(0, a + START.length) + "\n        " + renderPrinciples(list) + "\n        " + html.slice(b);
}
