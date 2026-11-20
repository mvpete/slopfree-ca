// Minimal OpenAI client (no SDK) with a hard token budget.
import { sleep } from "./util.js";

export class BudgetExceeded extends Error {}

export function createBudget(max) {
  let used = 0;
  return {
    add(n) {
      used += n;
      if (used > max) throw new BudgetExceeded(`Token budget of ${max.toLocaleString()} spent`);
    },
    get used() { return used; },
  };
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Model did not return JSON");
  }
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

  async function chat({ model, system, user, json = false }) {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: user });
    const body = { model, messages };
    if (json) body.response_format = { type: "json_object" };
    const data = await post("/v1/chat/completions", body);
    budget.add(data.usage?.total_tokens ?? 0);
    const text = data.choices?.[0]?.message?.content ?? "";
    return json ? parseJSON(text) : text;
  }

  async function moderate(input) {
    const data = await post("/v1/moderations", { model: "omni-moderation-latest", input });
    return data.results?.[0]?.flagged === true;
  }

  return { chat, moderate };
}
