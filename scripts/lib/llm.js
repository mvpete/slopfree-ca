// Model clients with one shared, hard dollar budget. OpenAI over plain fetch, Claude through the
// Anthropic SDK. createLLM sends each call to the right provider by model name.
import Anthropic from "@anthropic-ai/sdk";
import { sleep } from "./util.js";

export class BudgetExceeded extends Error {}

// prices: { model: { input, output } } in dollars per million tokens. A model with no price
// counts at the most expensive known price, so a typo in the config can't slip past the cap.
export function createBudget(maxUsd, prices = {}) {
  let used = 0;
  let usd = 0;
  const byModel = {};
  const byRole = {}; // { role: { calls, output } }: real output sizes, so later estimates improve
  const known = Object.values(prices);
  const fallback = {
    input: Math.max(0, ...known.map((p) => p.input)),
    output: Math.max(0, ...known.map((p) => p.output)),
  };
  // Cached input: writing to the cache costs 1.25x the input price, reading from it 0.1x.
  const cost = (model, input, output, cacheWrite = 0, cacheRead = 0) => {
    const p = prices[model] || fallback;
    return ((input + cacheWrite * 1.25 + cacheRead * 0.1) * p.input + output * p.output) / 1e6;
  };
  return {
    add(n, model = "unknown", input = 0, output = 0, { cacheWrite = 0, cacheRead = 0, role = "other" } = {}) {
      used += n;
      const c = cost(model, input, output, cacheWrite, cacheRead);
      usd += c;
      const m = (byModel[model] ||= { input: 0, output: 0, cachedInput: 0, usd: 0 });
      m.input += input + cacheWrite;
      m.cachedInput += cacheRead;
      m.output += output;
      m.usd += c;
      const r = (byRole[role] ||= { calls: 0, output: 0, usd: 0 });
      r.calls += 1;
      r.output += output;
      r.usd += c;
      if (usd > maxUsd) throw new BudgetExceeded(`Budget of $${maxUsd.toFixed(2)} spent`);
    },
    get used() { return used; },
    get usd() { return usd; },
    get left() { return maxUsd - usd; },
    get byModel() { return byModel; },
    get byRole() { return byRole; },
  };
}

// "gpt-6.2-sol: 400,000 in, 40,000 out, $1.20; ..." for logs and PR bodies.
export const spendLine = (budget) =>
  Object.entries(budget.byModel)
    .map(([m, t]) => `${m}: ${t.input.toLocaleString()} in, ${t.output.toLocaleString()} out, $${t.usd.toFixed(2)}`)
    .join("; ") || "none";

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Model did not return JSON");
  }
}

export const isClaude = (model) => /^claude-/.test(model);

// One chat() for every model. Each provider's key is only needed if a model from it is used.
export function createLLM({ budget, openaiKey, anthropicKey }) {
  let openai, claude;
  const get = (model) =>
    isClaude(model)
      ? (claude ||= createClaude({ apiKey: anthropicKey, budget }))
      : (openai ||= createOpenAI({ apiKey: openaiKey, budget }));
  return {
    chat: (opts) => get(opts.model).chat(opts),
    moderate: (input) => (openai ||= createOpenAI({ apiKey: openaiKey, budget })).moderate(input),
  };
}

// Claude: structured output against a JSON schema, so replies always parse. No refusal fallbacks
// on purpose: a different model quietly grading some summaries would make the comparison unfair,
// so a refusal is an error and that article is skipped.
export function createClaude({ apiKey, budget }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey, maxRetries: 4 });

  // shared: text that many calls repeat word for word (an article and its key points). It goes first,
  // marked for caching, so the second and later calls read it at a tenth of the price.
  // effort: null leaves the model's own default, which is what production traffic gets.
  async function chat({ model, system, shared, user, schema, effort = null, role, maxTokens = 16000 }) {
    const content = shared
      ? [{ type: "text", text: shared, cache_control: { type: "ephemeral" } }, { type: "text", text: user }]
      : user;
    const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content }] };
    if (effort) body.output_config = { effort };
    if (system) body.system = system;
    if (schema) body.output_config = { ...body.output_config, format: { type: "json_schema", schema } };
    let res;
    try {
      res = await client.messages.create(body);
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw new Error(`Claude ${e.status ?? ""}: ${e.message.slice(0, 300)}`);
      throw e;
    }
    const u = res.usage || {};
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    budget.add(input + output + cacheWrite + cacheRead, model, input, output, { cacheWrite, cacheRead, role });
    if (res.stop_reason === "refusal") throw new Error(`${model} declined (${res.stop_details?.category ?? "no category"})`);
    if (res.stop_reason === "max_tokens") throw new Error(`${model} ran out of output tokens`);
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return schema ? parseJSON(text) : text;
  }

  return { chat };
}

export function createOpenAI({ apiKey, budget }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  async function post(path, body) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch("https://api.openai.com" + path, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      const detail = await res.text();
      if (res.status !== 429 && res.status < 500) throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 300)}`);
      await sleep(2000 * 2 ** attempt);
    }
    throw new Error(`OpenAI kept failing on ${path}`);
  }

  // OpenAI caches repeated prompt prefixes by itself, so shared just goes first.
  // effort: sent as reasoning_effort when set; null leaves the model's default.
  async function chat({ model, system, shared, user, json = false, schema, effort = null, role }) {
    json ||= !!schema;
    if (schema) system = `${system || ""}\n\nReturn JSON matching this schema: ${JSON.stringify(schema)}`.trim();
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: shared ? `${shared}\n\n${user}` : user });
    const body = { model, messages };
    if (effort) body.reasoning_effort = effort;
    if (json) body.response_format = { type: "json_object" };
    const data = await post("/v1/chat/completions", body);
    // Cached prompt tokens are cheaper at OpenAI too, but we charge them at full price: the cap stays safe.
    budget.add(data.usage?.total_tokens ?? 0, model, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0, { role });
    const text = data.choices?.[0]?.message?.content ?? "";
    return json ? parseJSON(text) : text;
  }

  async function moderate(input) {
    const data = await post("/v1/moderations", { model: "omni-moderation-latest", input });
    return data.results?.[0]?.flagged === true;
  }

  return { chat, moderate };
}
