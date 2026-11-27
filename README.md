# slopfree.ca

Stop with the slop. Get to the point.

One prompt. Paste it at the end of any request and the AI says the same thing in fewer words. Live at [slopfree.ca](https://slopfree.ca).

## How it works

1. **Evaluate.** Each week a batch of candidate prompts goes up against the golden prompt on 10 random Wikipedia articles. A candidate passes only if, compared with golden, it:
   - keeps at least 95% as many key points
   - gets at least 5% more key points per word, after subtracting made-up claims
   - makes up no more claims
   - has no em dashes, and no more AI-style flourishes

   Then it has to pass again on 10 fresh articles. Golden itself is checked against a plain "Summarize the following article:" every week.
2. **Test.** The winner goes up against the golden prompt in the quiz. Readers decide.
3. **Rank.** If readers do better with it, it becomes the golden prompt.
4. **Repeat.** Indefinitely.

Losers are kept for posterity in [`prompts/openai/losers/`](prompts/openai/losers/), with why they lost. The long version is in [PLAN.md](PLAN.md).

## Models used

| Job | Model |
|---|---|
| Writes the summaries | `gpt-6-luna` |
| Lists each article's key points, judges which were kept, catches made-up claims | `claude-sonnet-5-5` |
| First-pass judge for screening candidates | `claude-haiku-5-5` |
| Drafts the week's candidate prompts (one batch of 4) | `gpt-6.2-sol` |
| Writes the quiz questions from the summaries | `gpt-4.1-mini` |

The judge is from a different family than the writer and the drafter on purpose. A model grading its own family's writing goes easy on it, and a drafter that's also the judge learns to please itself.

Change them in [`slopfree.config.json`](slopfree.config.json). Every result records which models made it, so numbers from different models never get mixed.

A run costs about $1–2. It stops hard at $2 (`maxUsdPerRun`), using the per-model prices in the config.

## Get the golden prompt

```sh
curl https://slopfree.ca/golden.txt             # just the prompt
curl https://api.slopfree.ca/v1/golden          # JSON: the prompt, its ID, and its latest eval numbers
```

Add `?model=openai` to pick a provider. Both are public, work from any origin, and update within 5 minutes of a new golden prompt.

## Submit your own

Think you can do better? Add `prompts/queue/<github-username>-<YYYY-MM-DD>.md` with just the prompt in it, and open a PR. One a day. Oldest gets tested first. More in [`prompts/queue/README.md`](prompts/queue/README.md).

## Run it

Node 22+. One dependency, the Anthropic SDK: `npm ci`.

Real runs need `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`.

```sh
npm test                    # tests
npm run eval:golden 3       # quick check: is golden still better than a plain summary, on 3 articles?
npm run eval:golden         # the same, 10 articles
npm run weekly              # the full weekly search
node scripts/build-site.js  # build _site/ for GitHub Pages

# The whole loop with fake model calls (Wikipedia is still real):
DRY_RUN=1 ARTICLES=4 SCREEN_ARTICLES=2 CANDIDATES=3 SLOPFREE_ROOT=/tmp/sf npm run weekly
```

Settings live in [`slopfree.config.json`](slopfree.config.json). Override them with `WRITER_MODEL`, `JUDGE_MODEL`, `SCREEN_JUDGE_MODEL`, `DRAFTER_MODEL`, `ARTICLES`, `SCREEN_ARTICLES`, `CANDIDATES`, `FINALISTS` and `MAX_USD`. Quiz thresholds are at the top of [`scripts/lib/decide.js`](scripts/lib/decide.js).

## Setup (maintainers)

**GitHub**
1. Secrets (Settings → Secrets and variables → Actions):
   - `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Put a monthly spending limit on both.
   - `SLOPFREE_APP_PRIVATE_KEY`, plus the variable `SLOPFREE_APP_ID`, from a GitHub App with read/write on *Contents*, *Pull requests* and *Issues*, installed on this repo. Bot PRs need it. PRs opened with the default Actions token don't trigger CI, so they'd never auto-merge.
   - `SLOPFREE_EXPORT_TOKEN`: a long random string. Set the same value on the Worker as `EXPORT_TOKEN`.
   - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, for `deploy-api.yml`.
2. Variables: `SLOPFREE_API_URL` (e.g. `https://api.slopfree.ca`) and `TURNSTILE_SITE_KEY`.
3. Settings → General: allow auto-merge. Settings → Pages: source "GitHub Actions", custom domain `slopfree.ca`.
4. Protect `main`: require the `ci / check` status.

**Cloudflare** (free plan)
1. Add `slopfree.ca` as a site and point the registrar's nameservers at Cloudflare.
2. `cd api && npx wrangler d1 create slopfree`. Put the `database_id` it prints in `api/wrangler.toml`.
3. Worker secrets: `npx wrangler secret put` for `EXPORT_TOKEN`, `TURNSTILE_SECRET` and `RATE_SALT`.
4. Make a Turnstile widget for `slopfree.ca`. Site key goes in the GitHub variable, secret key in the Worker.
5. Uncomment `routes` in `api/wrangler.toml` to serve the API at `api.slopfree.ca`. Push. `deploy-api.yml` runs the migrations and deploys.

Until `SLOPFREE_API_URL` is set, the quiz runs in practice mode and records nothing.

## License

Code: MIT ([LICENSE](LICENSE)). Content in `content/`: CC BY-SA 4.0, from Wikipedia ([content/LICENSE.md](content/LICENSE.md)).

Proudly made in Canada 🍁 Contains natural and artificial intelligence.
