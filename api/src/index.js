// slopfree.ca scoring API.
//   POST /v1/results  record one completed quiz
//   GET  /v1/golden   the current golden prompt as JSON (public, open CORS, cached)
//   GET  /v1/stats    reader counts per model (public, cached)
//   GET  /v1/export   all answers for a model (bearer EXPORT_TOKEN)
import { validateResults, HttpError } from "./validate.js";

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

function cors(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rateLimit(req, env) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const hour = Math.floor(Date.now() / 3600000);
  const key = await sha256(`${env.RATE_SALT || ""}:${ip}:${hour}`);
  const row = await env.DB.prepare(
    "INSERT INTO rate (key, hour, n) VALUES (?1, ?2, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n"
  ).bind(key, hour).first();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM rate WHERE hour < ?1").bind(hour - 1).run();
  if (row.n > Number(env.RATE_LIMIT_PER_HOUR || 30)) throw new HttpError(429, "Too many quizzes from this network. Try again in an hour.");
}

async function verifyTurnstile(token, req, env) {
  if (!env.TURNSTILE_SECRET) return; // not configured yet
  if (!token) throw new HttpError(403, "Missing bot check.");
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = req.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = await res.json();
  if (!out.success) throw new HttpError(403, "Bot check failed. Reload the page and try again.");
}

async function postResults(req, env) {
  if (Number(req.headers.get("Content-Length") || 0) > 20000) throw new HttpError(413, "Body too large.");
  let body;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
  const v = validateResults(body, { models: (env.MODELS || "").split(",") });
  await verifyTurnstile(v.token, req, env);
  await rateLimit(req, env);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const insert = env.DB.prepare(
    "INSERT INTO answers (session_id, created_at, model, prompt_id, slug, choice, read_ms, words, round, guess, hidden, qid) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
  );
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id, created_at, model, first_language, rating) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, now, v.model, v.firstLanguage, v.rating),
    ...v.answers.map((a) => insert.bind(id, now, v.model, a.promptId, a.slug, a.choice, a.readMs, a.words, a.round, a.guess ? 1 : 0, a.hidden ? 1 : 0, a.qid)),
  ]);
  return { ok: true };
}

async function stats(env) {
  const { results } = await env.DB.prepare("SELECT model, COUNT(*) AS n FROM sessions GROUP BY model").all();
  return { readers: Object.fromEntries(results.map((r) => [r.model, r.n])) };
}

async function exportRows(req, env, url) {
  const auth = req.headers.get("Authorization") || "";
  const expected = `Bearer ${env.EXPORT_TOKEN || ""}`;
  if (!env.EXPORT_TOKEN || auth.length !== expected.length || (await sha256(auth)) !== (await sha256(expected)))
    throw new HttpError(401, "Unauthorized.");
  const model = url.searchParams.get("model") || "openai";
  const since = url.searchParams.get("since") || "1970-01-01";
  const { results } = await env.DB.prepare(
    `SELECT a.session_id, a.created_at, a.model, a.prompt_id, a.slug, a.choice, a.read_ms, a.words, a.round, a.guess, a.hidden, a.qid, s.first_language, s.rating
     FROM answers a JOIN sessions s ON s.id = a.session_id
     WHERE a.model = ?1 AND a.created_at >= ?2 ORDER BY a.id`
  ).bind(model, since).all();
  return json({ rows: results.map((r) => ({ ...r, guess: r.guess === 1, hidden: r.hidden === 1 })) }, 200, {});
}

// The golden prompt is published with the site; this endpoint serves it from the API host with open CORS.
async function golden(env, url) {
  const model = url.searchParams.get("model");
  if (model && !/^[a-z0-9-]{1,40}$/.test(model)) throw new HttpError(400, "Bad model name.");
  const site = (env.SITE_URL || "https://slopfree.ca").replace(/\/$/, "");
  const res = await fetch(model ? `${site}/api/golden/${model}.json` : `${site}/golden.json`, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (res.status === 404) throw new HttpError(404, `No golden prompt for model "${model}".`);
  if (!res.ok) throw new HttpError(502, "Couldn't load the golden prompt. Try again in a minute.");
  return new Response(await res.text(), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = cors(env, req.headers.get("Origin"));
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (url.pathname === "/v1/results" && req.method === "POST") return json(await postResults(req, env), 200, headers);
      if (url.pathname === "/v1/golden" && req.method === "GET") return await golden(env, url);
      if (url.pathname === "/v1/stats" && req.method === "GET")
        return json(await stats(env), 200, { ...headers, "Cache-Control": "public, max-age=300" });
      if (url.pathname === "/v1/export" && req.method === "GET") return await exportRows(req, env, url);
      return json({ error: "Not found." }, 404, headers);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, headers);
      console.error(e);
      return json({ error: "Something went wrong on our side. Try again in a minute." }, 500, headers);
    }
  },
};
