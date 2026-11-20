export const slugify = (s) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

export const wordCount = (s) => (s.trim().match(/\S+/g) || []).length;

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "n/a");

// Run fn over items with at most `limit` in flight. Results keep input order.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Files use p-0001; people see "1".
export const promptName = (id) => String(Number(String(id).replace(/^p-/, "")));

// Community submissions: prompts/queue/<github-username>-<YYYY-MM-DD>[-<n>].md, tested oldest first.
export const QUEUE_NAME = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
