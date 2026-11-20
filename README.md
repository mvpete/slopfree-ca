# slopfree.ca

A prompt you paste after any request so AI says the same thing in less text.

Every prompt has to earn its place:

1. **Eval.** Each week the pipeline summarizes 10 random Wikipedia articles with a plain "Summarize the following article:" prompt (the baseline) and with candidate prompts. A candidate passes only if it keeps ≥98% of the article's points that the baseline keeps, adds no more unsupported claims, and uses ≥20% fewer words. Then it has to pass again on 10 fresh articles.
2. **Reader test.** The winner runs against the current golden prompt in the site's quiz. Readers decide.

Losers are kept in [`prompts/openai/losers/`](prompts/openai/losers/) with why they lost. The full plan is in [PLAN.md](PLAN.md).

## Run it

Node 22+. No dependencies.

```sh
npm test                                   # gate, decision and API validation tests
OPENAI_API_KEY=... npm run eval:golden 5   # cheap smoke test: does golden pass on 5 articles?
OPENAI_API_KEY=... npm run eval:golden     # the real pre-launch check (10 articles)
OPENAI_API_KEY=... npm run weekly          # the full weekly search
node scripts/build-site.js                 # build _site/ for GitHub Pages

# Whole loop with fake model calls (still fetches real Wikipedia articles):
DRY_RUN=1 ARTICLES=4 SCREEN_ARTICLES=2 MAX_ATTEMPTS=5 SLOPFREE_ROOT=/tmp/sf npm run weekly
```

Settings are in [`slopfree.config.json`](slopfree.config.json): models, gate thresholds, article counts, token budget. `WRITER_MODEL`, `JUDGE_MODEL`, `ARTICLES`, `SCREEN_ARTICLES`, `MAX_ATTEMPTS` and `MAX_TOKENS` override them. Reader-test thresholds are at the top of [`scripts/lib/decide.js`](scripts/lib/decide.js).

## Submit a prompt

Add `prompts/queue/<github-username>-<YYYY-MM-DD>.md` containing only the prompt (add `-2`, `-3` for more on the same day), and open a PR. Submissions are tested oldest first. Details in [`prompts/queue/README.md`](prompts/queue/README.md).

## Setup (maintainers)

**GitHub**
1. Secrets (Settings → Secrets and variables → Actions):
   - `OPENAI_API_KEY`. Set a monthly spending limit on the key.
   - `SLOPFREE_APP_PRIVATE_KEY` and variable `SLOPFREE_APP_ID`, from a GitHub App with *Contents*, *Pull requests* and *Issues* read/write, installed on this repo. Bot PRs need it, because PRs opened with the default Actions token don't trigger CI, so auto-merge would never fire.
   - `SLOPFREE_EXPORT_TOKEN`: a long random string, also set on the Worker as `EXPORT_TOKEN`.
   - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, for `deploy-api.yml`.
2. Variables: `SLOPFREE_API_URL` (for example `https://api.slopfree.ca`) and `TURNSTILE_SITE_KEY`.
3. Settings → General: allow auto-merge. Settings → Pages: source "GitHub Actions", custom domain `slopfree.ca`.
4. Branch protection on `main`: require the `ci / check` status.

**Cloudflare** (free plan)
1. Add `slopfree.ca` as a site and point the registrar's nameservers at Cloudflare.
2. `cd api && npx wrangler d1 create slopfree`, then put the printed `database_id` in `api/wrangler.toml`.
3. Worker secrets: `npx wrangler secret put EXPORT_TOKEN`, `TURNSTILE_SECRET` and `RATE_SALT`.
4. Create a Turnstile widget for `slopfree.ca`. The site key goes in the GitHub variable, the secret key in the Worker.
5. Uncomment the `routes` line in `api/wrangler.toml` to serve the API at `api.slopfree.ca`. Push, and `deploy-api.yml` applies migrations and deploys.

Until `SLOPFREE_API_URL` is set, the quiz runs in practice mode and nothing is recorded.

## License

Code: MIT ([LICENSE](LICENSE)). Article-derived content in `content/`: CC BY-SA 4.0, from Wikipedia ([content/LICENSE.md](content/LICENSE.md)).
