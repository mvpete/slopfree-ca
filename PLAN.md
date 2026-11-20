# slopfree.ca plan

Slop Free is a lossless AI compression prompt: same accuracy as a plain "Summarize this", with at least 20% less text. Machines check it first, then people.

## How a prompt earns golden

A weekly cycle, one challenger per week. Every Monday:

1. **Decide last week's trial.** If the challenger beat golden in the reader test, it becomes golden. Otherwise golden stays.
2. **Archive the loser** in "Close but no cigar" with the reason it lost.
3. **Eval (machine).** An AI drafts candidate prompts until one passes the gate against a plain summarization baseline, up to 20 attempts, drafted by `gpt-6.2-sol` with the gate targets (≥98% of the baseline's points, ≥20% fewer words).
4. **Reader test (human).** The new challenger runs head to head against golden for the week.

Every step is a bot PR that auto-merges, so the record of each change stays in git.

The eval tests the claim (lossless, shorter). The reader test checks that people actually get it.

## Decisions

| Area | Decision |
|---|---|
| Hosting | GitHub Pages, vanilla HTML/CSS/JS, no build step |
| Scores | Cloudflare Worker + D1 (free tier) |
| Generation | GitHub Actions, ahead of time. Readers never trigger an AI call |
| Models | OpenAI first. Each model has its own golden prompt |
| Promotion | Weekly bot PRs with supporting data, auto-merged when CI passes |
| Source | Random Wikipedia articles, revision pinned |
| Funding | Owner pays API costs. GitHub Sponsors |
| Wikipedia User-Agent | `slopfree-ca/0.1 (https://github.com/mvpete/slopfree-ca)` |
| License | Code MIT. `content/` CC BY-SA 4.0, attributed per article |

## The eval

**Task wrapper**, identical for every run: `Summarize the following article:` + article text.
**Baseline** = the wrapper alone. **Candidate** = the wrapper plus the candidate postfix. So the eval measures exactly what the postfix adds.

### Per weekly search
1. **Pick 10 random articles.** Skip stubs, lists and disambiguation pages; require ~1,500+ words. Pin revisions.
2. **List every point once per article**: every atomic claim the article makes, section by section, with no cap on the count. This is the answer key.
3. **Baseline once per article**: summarize, then judge which points it covers and count tokens.
4. **Search loop**, up to 20 attempts (drafter: `gpt-6.2-sol`):
   1. Draft a candidate: a variation of the golden prompt, or the next community submission. The drafter sees why earlier attempts failed (points dropped, length ratio).
   2. **Screen** on 3 of the 10 articles. Fail → next attempt.
   3. **Full run** on all 50. Fail → next attempt.
   4. **Confirm** on 10 fresh articles, so the winner isn't tuned to the search set. Golden is summarized on the same articles. Pass → summarize 20 more fresh articles with both prompts, open the challenger PR (auto-merges), and stop. These 30 articles are the week's quiz content, so a reader never sees the same article twice.
5. No pass after 20 attempts: the three closest candidates go to "Close but no cigar", golden runs alone for the week, and the workflow run is marked failed.

### Gate (all must hold, across the article set)
| Check | Pass if |
|---|---|
| Coverage | ≥98% of the points the baseline covers (equally accurate) |
| Accuracy | Unsupported or wrong claims no more frequent than baseline |
| Length | Median tokens ≤80% of baseline (≥20% less text) |
| Floor | No single article below 90% of baseline coverage |

No prompt reaches readers without passing this gate, golden included:
- **Golden v1 must pass before launch.** If it fails, it gets revised until it passes.
- **Golden is re-checked in every search run.** If it fails, the run opens an issue.
- Results are published.

### Judging
- A stronger model than the writer judges. It never sees which prompt wrote the summary.
- One call per summary checks all points. Each point is judged twice, and a disagreement counts as missing.
- Before trusting the gate, validate the judge against ~20 hand-graded summaries.
- Later: a second judge from another provider to cut same-family bias.

### Cost
Baseline and point extraction run once per article. A failed screen costs ~20 calls; a full run ~100. Worst case (50 full attempts) is ~5,000 calls a week, so the workflow enforces a hard per-run token budget and stops when it's spent. Set a monthly spending limit on the API key too.

## The reader test

- Quiz summaries come from the golden and challenger prompts. Each question tests one of the article's points.
- Each quiz mixes golden and challenger at random.
- Reading time is compared with the median of the quiz it came from, so a slow day doesn't count against one prompt.
- Dropped: impossible reading speed, a hidden tab while reading, quizzes abandoned after one answer.
- Optional "Is English your first language?" at the end. Once there are enough readers whose first language isn't English, a prompt that hurts them can't win.
- **Sized for one reader.** Expect about 25 answers a week, possibly all from the maintainer. Guess rounds are off, and the quiz never shows a browser the same article twice.
- **One week per trial.** Reading speed is the main signal; accuracy is a veto. The challenger wins if there's a ≥90% chance readers were faster and under a 60% chance their accuracy fell by more than 10 points. Fewer than 10 answers per prompt is a thin week, and golden stays.
- **What 25 answers can tell.** In simulation, a challenger with equal accuracy that reads 23% faster wins about 57% of weeks. One that isn't faster wins about 12% of weeks, and one at 40% accuracy against golden's 75% wins about 12%. Fifty answers (a two-week trial) raise the good case to about 81%.
- The verdict is seeded and recomputed by CI from the data snapshot, so it can't be hand-edited.
- A thin week means golden stays. The loss reason says so, such as "Not enough evidence: 6 challenger and 7 golden answers (needs 10 each)."
- With no challenger that week, golden runs alone and still collects baseline data.

## Close but no cigar

Every losing prompt is kept, with its text, its numbers and a one-line reason:

| Lost at | Example reason |
|---|---|
| Eval: coverage | "Covered 94% of baseline points (needs 98%). Dropped dates and causes most often." |
| Eval: length | "Only 12% shorter than baseline (needs 20%)." |
| Eval: accuracy | "3 unsupported claims per 50 summaries vs baseline's 1." |
| Eval: fresh articles | "Passed the search set, failed on fresh articles: coverage 95%." |
| Reader test | "Readers scored 4% lower and read 6% slower than golden." |
| Reader test: thin week | "Not enough evidence: 312 answers, 71% chance it was better." |

Each loser is a file in the repo, `prompts/<model>/losers/<id>.md`, holding the prompt, why it lost, and its numbers. From the eval, the three closest misses each week get a file; every attempt is also logged in `evals/<date>.json`. Every reader-test loser gets a file.

## Workflows

| Workflow | When | Does | Writes |
|---|---|---|---|
| `weekly-topics.yml` | Mondays + manual | Runs `golden-pull.js` (decide last week's trial), then `weekly-topics.js` (eval and search). One bot PR | `golden.json`, `active.json`, `prompts/<model>/`, `content/articles/`, `evals/`, `data/` |
| `golden-pull.yml` | Manual | Decision only, for deciding mid-week | `golden.json`, `active.json`, `prompts/<model>/losers/`, `evals/`, `data/` |
| `ci.yml` | Every PR and push | Tests; bot-PR guardrails (paths, prompt length, gate and decision recomputed) | nothing |
| `deploy.yml` | Merge to main | Builds `_site` with `content/index.json` and publishes Pages | nothing committed |
| `deploy-api.yml` | Changes under `api/` | D1 migrations, then deploys the Worker | nothing committed |

The decision and the search run in one job, so the search always targets the golden prompt the decision just settled.

**Auto-merge guardrails.** A bot PR merges itself only if all of these hold:
- it only touches `prompts/`, `content/`, `evals/`, `data/`
- CI re-verifies the gate from stored numbers, and recomputes the reader-test decision from the data snapshot
- the prompt is under a length cap and passes a content check

Community submissions need maintainer approval to enter the queue. Bot PRs use a GitHub App token, because PRs opened with the default Actions token don't trigger CI.

Challenger PR contains the prompt text, a gate table (coverage, accuracy, length vs baseline), per-article results, worst three articles, sample summary pairs, and the number of attempts it took.

The weekly decision PR contains the `golden.json` diff (if promoted) or the loser file (if not), both prompt texts, reader results (answers, adjusted accuracy, relative reading time, confidence), per-article breakdown, and a data snapshot link.

## Repository layout

```
index.html, css/, js/                         front end
prompts/<model>/golden.json                   { "id": "p-0001" }
prompts/<model>/p-0001.md                     prompt text, immutable
prompts/<model>/active.json                   this week's challenger (0 or 1)
prompts/<model>/losers/<id>.md                Close but no cigar: prompt, why it lost, numbers
prompts/queue/*.md                            community submissions
content/articles/<slug>/source.json           title, revision, URL, license
content/articles/<slug>/points.json           major points + quiz question
content/articles/<slug>/baseline.json         baseline summary, coverage, tokens
content/articles/<slug>/<model>/<id>.json     summary, coverage, tokens
evals/<date>.json                             weekly eval report
evals/<date>-decision.json                    weekly reader-test decision
data/answers-<date>.json                      anonymous answers snapshot behind the decision
scripts/                                      Node pipeline
api/                                          Worker + D1 schema
.github/workflows/
```

## Front end

Five snap-scroll sections under a fixed menu (About, How to use, Quiz, Human first, GitHub, Sponsor):

1. **Home**: "I'm over the text wall.", slop parody line, "Let's remember who we're writing for.", golden prompt code box.
2. **About**: how a prompt earns golden. Should lead with the compression claim and this week's eval numbers.
3. **How to use it**: one message vs custom instructions, where to save it, tips.
4. **Quiz**: one button per model, 5 rounds, results.
5. **Human First Design**: the principles, one file each in `principles/NN-name.md`. The deploy renders every file in name order, so adding `08-….md` adds a principle. The footer sits under it.

Warm graphite background (`#34302A`, never black), gold accent (`#D4AF37`), cream text. Inter and JetBrains Mono.

## Privacy and abuse

- Stored per answer: model, prompt ID, article, correct or not, reading time, random session ID, round type, optional first-language answer. No IPs, accounts or cookies.
- Turnstile on session start, rate limits on the Worker.
- Each weekly decision commits its anonymous data snapshot to `data/answers-<date>.json`, so anyone can audit the ranking.

## Build order

1. Front end: done.
2. Eval: done. Needs a real run: golden v1 must pass, and the judge needs checking against ~20 hand-graded summaries.
3. Front end on real content: done (falls back to sample content when `content/index.json` is missing).
4. Scoring API: done (Worker + D1, Turnstile, rate limits, export). Needs Cloudflare setup.
5. Weekly decision: done.
6. Later: French version, public leaderboard page, second-provider judge.
