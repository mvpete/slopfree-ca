// Random Wikipedia articles as plain text, pinned to a revision.
import { slugify, wordCount, sleep } from "./util.js";

const DROP_SECTIONS = /^(see also|references|external links|notes|further reading|bibliography|sources|citations|footnotes|works cited)$/i;

export function createWiki({ lang, userAgent }) {
  const api = `https://${lang}.wikipedia.org/w/api.php`;

  async function get(params) {
    const url = api + "?" + new URLSearchParams({ format: "json", formatversion: "2", ...params });
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { headers: { "User-Agent": userAgent, "Api-User-Agent": userAgent } });
      if (res.ok) return res.json();
      if (res.status !== 429 && res.status < 500) throw new Error(`Wikipedia ${res.status} for ${url}`);
      await sleep(1000 * 2 ** attempt);
    }
    throw new Error(`Wikipedia kept failing for ${url}`);
  }

  // Random main-namespace pages that look like real articles (not lists, not disambiguation, not stubs).
  async function randomTitles() {
    const data = await get({
      action: "query",
      generator: "random",
      grnnamespace: "0",
      grnlimit: "50",
      prop: "info|pageprops",
      ppprop: "disambiguation",
    });
    return (data.query?.pages || [])
      .filter((p) => !p.pageprops?.disambiguation && p.length >= 12000 && !/^(lists? of|outline of|index of|glossary of) /i.test(p.title))
      .map((p) => p.title);
  }

  async function fetchArticle(title, { maxWords }) {
    const data = await get({
      action: "query",
      prop: "extracts|revisions",
      explaintext: "1",
      exsectionformat: "wiki",
      rvprop: "ids",
      redirects: "1",
      titles: title,
    });
    const page = data.query?.pages?.[0];
    if (!page || page.missing || !page.extract) return null;

    // Cut reference-type sections, then flatten "== Heading ==" to plain lines.
    const lines = [];
    let skipping = false;
    for (const line of page.extract.split("\n")) {
      const h = line.match(/^(=+)\s*(.*?)\s*\1\s*$/);
      if (h) {
        skipping = DROP_SECTIONS.test(h[2]);
        if (!skipping) lines.push("", h[2]);
        continue;
      }
      if (!skipping) lines.push(line);
    }
    let text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const words = text.match(/\S+/g) || [];
    if (words.length > maxWords) text = words.slice(0, maxWords).join(" ");

    const revid = page.revisions?.[0]?.revid;
    return {
      slug: slugify(page.title),
      source: {
        title: page.title,
        pageid: page.pageid,
        revision: revid,
        url: `https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(page.title.replace(/ /g, "_"))}&oldid=${revid}`,
        license: "CC BY-SA 4.0",
        words: Math.min(words.length, maxWords),
      },
      text,
    };
  }

  // Collect `n` usable articles, skipping slugs in `exclude`.
  async function pickArticles(n, { minWords, maxWords, exclude = new Set() }) {
    const picked = [];
    for (let batch = 0; batch < 40 && picked.length < n; batch++) {
      for (const title of await randomTitles()) {
        if (picked.length >= n) break;
        if (exclude.has(slugify(title))) continue;
        const art = await fetchArticle(title, { maxWords });
        if (!art || exclude.has(art.slug) || wordCount(art.text) < minWords) continue;
        exclude.add(art.slug);
        picked.push(art);
      }
    }
    if (picked.length < n) throw new Error(`Only found ${picked.length} of ${n} usable articles`);
    return picked;
  }

  return { pickArticles, fetchArticle };
}
