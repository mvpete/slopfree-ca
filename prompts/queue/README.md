# Community submissions

Add one file per prompt, containing only the prompt text, and open a PR:

`prompts/queue/<github-username>-<YYYY-MM-DD>.md`

For more than one on the same day, add `-2`, `-3`: `mvpete-2026-11-20-2.md`. Submit as many as you like.

After a maintainer merges it, the weekly search tests submissions oldest first, before drafting its own. Each one has to pass the same eval as every other prompt. If it loses, it gets a file in `prompts/openai/losers/` crediting you, with why it lost.
