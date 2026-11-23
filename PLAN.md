# slopfree.ca plan

Slop Free is an experiment to find one prompt that makes AI get to the point. Same facts as a plain "Summarize this", at least 15% fewer words. Machines check it first. Then people do.

## How a prompt becomes golden

One challenger a week. Every Friday:

1. **Decide last week.** If the challenger beat golden in the quiz, it's the new golden. If not, golden stays.
2. **Keep the loser** in "Close but no cigar", with why it lost.
3. **Evaluate.** `gpt-6.2-sol` drafts candidate prompts until one passes the gate. Up to 20 tries.
4. **Test.** The new challenger goes head to head with golden in the quiz for the week.

Each step is a bot PR that merges itself, so every change is in git.

The eval checks the claim: nothing lost, fewer words. The quiz checks that people actually read it better.

## Decisions

| Area | Decision |
|---|---|
| Hosting | GitHub Pages. Plain HTML, CSS and JS. No build step |
| Scores | Cloudflare Worker + D1, free tier |
| Generation | GitHub Actions, ahead of time. Readers never trigger an AI call |
| Models | OpenAI first. Each model gets its own golden prompt |
| Promotion | Weekly bot PRs with the data, auto-merged when CI passes |
| Source | Random Wikipedia articles, revision pinned |
| Funding | The owner pays the API bill. GitHub Sponsors helps |
| Wikipedia User-Agent | `slopfree-ca/0.1 (https://github.com/mvpete/slopfree-ca)` |
| License | Code MIT. `content/` CC BY-SA 4.0, credited per article |

## The eval

Every run uses the same wrapper: `Summarize the following article:` + the article.

- **Baseline:** the wrapper alone.
- **Candidate:** the wrapper plus the candidate prompt.

So the eval measures only what the prompt adds.

### Each week
1. **Pick 10 random articles.** 1,500 words or more. No stubs, lists or disambiguation pages. Pin the revision.
2. **List every point** in each article, section by section, no cap. That's the answer key.
3. **Run the baseline** once per article. Judge which points it kept. Count tokens.
4. **Search**, up to 20 tries:
   1. Draft a candidate: a variation on golden, or the next community submission. The drafter sees why earlier tries failed.
   2. **Screen** on 3 of the 10 articles. Fail → next try.
   3. **Full run** on all 10. Fail → next try.
   4. **Confirm** on 10 fresh articles, so the winner isn't tuned to the first set. Golden runs on the same ones. Pass → summarize 20 more fresh articles with both prompts, open the challenger PR, stop. Those 30 articles are the week's quiz, so nobody sees the same article twice.
5. **Nothing passed after 20 tries:** the three closest go to "Close but no cigar", golden runs alone for the week, and the run is marked failed.

### The gate
Every check has to pass, across all the articles.

| Check | Passes if |
|---|---|
| Key points | At least 95% as many key points as the baseline. Any key points, not just the ones the baseline picked. Details don't count |
| Accuracy | No more made-up or wrong claims than the baseline |
| Efficiency | 1.18× the baseline's key points per word, median article. That's the same key points in 15% fewer words |
| No AI style | Zero em dashes, counted by code. No more literary or AI-style phrases than the baseline, flagged by the judge |
| Floor | No single article under 85% of the baseline's key points |

Nothing reaches readers without passing, golden included.
- **Golden v1 has to pass before launch.** If it fails, rewrite it until it passes.
- **Golden is re-checked every week.** If it fails, the run opens an issue.
- Results are public.

### Judging
- The judge is a stronger model than the writer. It never knows which prompt wrote a summary.
- One call per summary. The judge grades against the point list, not the article. The list holds every claim, so it's enough to catch made-up ones too. Baseline and candidates are graded the same way.
- Before trusting the gate, check the judge against about 20 summaries graded by hand.
- Later: a second judge from another provider, so one model family isn't grading itself.

### Cost
Target: about $1 a run.
- Only point extraction reads the article, and only its first 3,000 words.
- The cheaper writer model writes the summaries.
- Grading reads the point list once.
- The 20 quiz-only articles get points and two summaries. No baseline, no grading.
- A hard stop at 1.2M tokens ends the run cleanly. Each PR reports tokens per model.

The first run, on the old design, cost about $4. It re-read the article twice per grade and used 6,000-word articles.

## The quiz

- Summaries come from golden and the challenger, mixed at random. Each question tests one point from the article.
- Reading time is compared with the median for that quiz, so a slow day doesn't count against one prompt.
- Thrown out: impossible reading speeds, a hidden tab while reading, quizzes quit after one answer.
- Every question has "Too hard / I don't know". It counts as wrong. Each quiz ends with one tap: **Too hard · Too easy · Good**. It's reported in the Friday PR.
- **Built for a handful of readers.** Expect about 25 answers a week, maybe all from the maintainer. Guess rounds are off. A browser never sees the same article twice.
- **One week per trial.** Reading speed decides. Accuracy can veto. The challenger wins if there's at least a 90% chance readers were faster and under a 60% chance their accuracy dropped more than 10 points. Under 10 answers per prompt is a thin week, and golden stays.
- **What 25 answers can tell you.** In simulation, a challenger that's 23% faster with the same accuracy wins about 57% of weeks. One that isn't faster wins about 12%. One at 40% accuracy against golden's 75% also wins about 12%. A two-week trial (50 answers) lifts the good case to about 81%.
- CI recomputes the verdict from the data snapshot, with a fixed seed. Nobody can hand-edit it.
- A thin week says so: "Not enough evidence: 6 challenger and 7 golden answers (needs 10 each)."
- No challenger that week? Golden runs alone and still collects baseline data.

## Close but no cigar

Every losing prompt is kept: its text, its numbers, and one line on why it lost.

| Lost at | Example |
|---|---|
| Eval: key points | "Kept 92% as many of the articles' points as the baseline (needs 95%)." |
| Eval: length | "Only 12% shorter than baseline (needs 15% shorter)." |
| Eval: accuracy | "3 unsupported claims per 50 summaries vs baseline's 1." |
| Eval: fresh articles | "Passed the search set, failed on fresh articles: coverage 95%." |
| Quiz | "Readers scored 4% lower and read 6% slower than golden." |
| Quiz: thin week | "Not enough evidence: 312 answers, 71% chance it was better." |

Each loser is a file: `prompts/<model>/losers/<id>.md`. From the eval, the three closest misses each week get a file, and every try is logged in `evals/<date>.json`. Every quiz loser gets a file.

## Workflows

| Workflow | When | What it does | Writes |
|---|---|---|---|
| `weekly-topics.yml` | Fridays, or by hand | `golden-pull.js` decides last week, then `weekly-topics.js` runs the eval and search. One bot PR | `golden.json`, `active.json`, `prompts/<model>/`, `content/articles/`, `evals/`, `data/` |
| `golden-pull.yml` | By hand | Just the decision, for mid-week | `golden.json`, `active.json`, `prompts/<model>/losers/`, `evals/`, `data/` |
| `ci.yml` | Every PR and push | Tests. Guardrails on bot PRs | nothing |
| `deploy.yml` | Merge to main | Builds `_site` with `content/index.json`, publishes Pages | nothing committed |
| `deploy-api.yml` | Changes under `api/` | D1 migrations, then deploys the Worker | nothing committed |

The decision and the search run in one job, so the search always targets the golden prompt that was just decided.

**Auto-merge guardrails.** A bot PR merges itself only if:
- it only touches `prompts/`, `content/`, `evals/` and `data/`
- CI re-checks the gate from the stored numbers and recomputes the quiz decision from the data snapshot
- the prompt is under the length cap and passes a content check

Community submissions need a maintainer to approve them into the queue. Bot PRs use a GitHub App token, because PRs from the default Actions token don't trigger CI.

**The challenger PR** has the prompt, a gate table, per-article results, the worst three articles, sample summary pairs, and how many tries it took.

**The Friday decision PR** has the `golden.json` change (if promoted) or the loser file (if not), both prompts, quiz results (answers, accuracy, reading time, confidence), per-article results, and a link to the data snapshot.

## Repository layout

```
index.html, css/, js/                         front end
prompts/<model>/golden.json                   { "id": "p-0001" }
prompts/<model>/p-0001.md                     prompt text, never edited
prompts/<model>/active.json                   this week's challenger (0 or 1)
prompts/<model>/losers/<id>.md                Close but no cigar: prompt, why it lost, numbers
prompts/queue/*.md                            community submissions
content/articles/<slug>/source.json           title, revision, URL, license
content/articles/<slug>/points.json           points + quiz question
content/articles/<slug>/baseline.json         baseline summary, coverage, tokens
content/articles/<slug>/<model>/<id>.json     summary, coverage, tokens
evals/<date>.json                             weekly eval report
evals/<date>-decision.json                    weekly quiz decision
data/answers-<date>.json                      anonymous answers behind the decision
scripts/                                      Node pipeline
api/                                          Worker + D1 schema
.github/workflows/
```

## Front end

Snap-scroll sections under a fixed menu: About, How to use, Quiz, Human first, Examples, GitHub, Sponsor. Examples is its own page, `examples.html`, built at deploy.

1. **Home:** "I'm over the wall of text.", the slop parody, "Let's remember who we're writing for.", and the golden prompt.
2. **About:** "Stop with the slop. Get to the point." Evaluate, Test, Rank, Repeat. Fact cards and the models used.
3. **How to use it:** one message or every chat, where to save it, tips.
4. **Quiz:** 5 short questions, then your result.
5. **Human First Design:** the principles, one file each in `principles/NN-name.md`. The deploy renders them in file-name order, so adding `08-….md` adds a principle.

Warm graphite background (`#34302A`, never black), gold accent (`#D4AF37`), cream text. Inter and JetBrains Mono.

## Privacy and abuse

We don't want your data.
- Stored per answer: model, prompt ID, article, right or wrong, reading time, a random session ID, round type, a fingerprint of the question (so answers only count against the question actually shown), and the difficulty tap. No IPs, accounts or cookies.
- Turnstile on session start. Rate limits on the Worker.
- Each Friday decision commits its anonymous data to `data/answers-<date>.json`. Anyone can check the ranking.

## Build order

1. Front end: done.
2. Eval: done. Still needs a real run. Golden v1 has to pass, and the judge needs checking against about 20 hand-graded summaries.
3. Front end on real content: done. Falls back to sample content when `content/index.json` is missing.
4. Scoring API: done (Worker + D1, Turnstile, rate limits, export). Needs Cloudflare setup.
5. Weekly decision: done.
6. Later: French version, a public leaderboard, a second-provider judge.
