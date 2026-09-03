# Opportunity Finder

A daily job that pulls sales-ops work from Upwork, LinkedIn Jobs and Indeed, scores
each posting against a capability rubric, drafts outreach, and writes everything to a
Google Sheet. Nothing is sent without a checked box.

## How a run goes

```
ingest -> normalize -> dedupe -> classify -> score -> enrich -> draft -> send -> digest -> Runs row
```

Every stage reads its inputs from the sheet and writes its outputs back before the
next one starts. A crash halfway leaves the sheet consistent and the next run picks
up from it. Re-running the same day adds no rows and sends no second email.

## Setup

```bash
npm install
npm install -g @anthropic-ai/claude-code   # the default model backend
claude setup-token                         # long-lived token, needs a Claude subscription
cp .env.example .env                       # paste the token, fill in the rest
npm run setup-sheet                        # creates tabs, headers, checkboxes, Config defaults
npm test
npm run run-once -- --skip-send
```

Create the spreadsheet yourself, put its id in `SHEET_ID`, and share it with the
service account's `client_email` as an Editor. Without that share every API call
returns 403.

`setup-sheet` is additive and safe to re-run. It appends missing columns and never
deletes or reorders what is already there.

## Before the first real run: verify the actors

**No actor id or field name in `config/actors.json` has been verified.** apify.com was
unreachable from the environment this was built in, so the mappings are educated
guesses and the fixtures under `test/fixtures/` are hand-authored rather than captured
from live runs.

Fix that first:

```bash
npm run probe-actor -- indeed "sales operations"
```

It runs the actor once on five results, saves the raw output to `.probe/indeed.json`,
prints every key on the first item, and shows which mapped fields resolve against
reality. Correct any `NO HIT` line in `config/actors.json` and probe again. Repeat for
`upwork` and `linkedin`.

Then replace the fixtures with the real payloads and run `npm test`. A test that fails
at that point is telling you the mapping is wrong, which is what you want to learn
before a scheduled run does.

`normalize.js` reads those mappings and knows no actor field names of its own, so
swapping an actor or fixing a mapping is a config edit rather than a code change. When
a mapping stops resolving a required field the source fails loudly: it is named in the
Runs row and in the digest instead of quietly returning fewer results.

## The model backend

Two backends, one environment variable, no other code difference.

**`LLM_BACKEND=claude_code`** (default) runs the model through headless Claude Code
on a Claude subscription. No separate API bill. Set `CLAUDE_CODE_OAUTH_TOKEN` from
`claude setup-token`.

**`LLM_BACKEND=api`** uses the Anthropic Messages API and needs `ANTHROPIC_API_KEY`.
It bills separately, and in exchange the API enforces the JSON schema server-side
rather than the validate-and-retry loop the subscription route uses. If
classification reliability ever becomes the bottleneck, this is the switch.

Measured on the subscription route, per classified post: **about $0.015 of
quota-equivalent and four seconds**. A first run over a 14-day lookback is a few
hundred posts, so budget roughly $7 of quota once, then well under $1 a day.

Two things about the subscription route are worth knowing before you rely on it.

The invocation passes `--tools ""`. Claude Code ships its tool definitions in every
request, and on a trivial prompt that measured 26,438 input tokens per call against
509 with tools stripped. On a workload that makes one call per job posting, that flag
is the difference between viable and not. It also never passes `--bare`, which forces
API-key-only auth and never reads the OAuth credentials a subscription uses.

The binding limit is your usage window, not money. When a run hits it, classification
stops, the remaining posts stay `pending`, and the digest says how many were deferred.
Nothing is lost and the next run picks them up. On a first run over a large backlog,
expect this to happen and expect the backlog to clear over two or three days.

## The pre-filter

Postings are rejected on compensation and on obviously unrelated titles before any
model call happens.

The compensation half is not a heuristic. It calls `checkCompensation`, the same
function `score.js` uses for rule 3, which reads nothing from the classification and
so can run early with an identical verdict. A post dropped here gets the reason it
would have got afterwards, and a test asserts the two can never disagree.

The title half is a heuristic and is deliberately narrow. Terms match on word
boundaries, not substrings, because an earlier substring version matched "Serverless
Platform Engineer" against the restaurant term "server" and would have silently
dropped the lead. A wrong entry costs a lead that never reaches the sheet; a missing
entry costs about a cent. Anything borderline goes to the model.

Set `Config.prefilter_enabled` to `FALSE` to send everything to the model, which is
how you prove the pre-filter is not the reason something went missing.

## The sheet

| Tab | What it holds |
| --- | --- |
| Posts | One row per unique posting, with its score and status |
| PostsRaw | Description and raw payload, keyed by post_id. This is what `replay` reads |
| Leads | Postings that passed the gate, with contact and channel |
| Outreach | One draft per lead, with the APPROVE checkbox |
| Runs | One row per run: counts, cost estimate, errors |
| Config | Runtime overrides. These beat `config/scoring.json` without a deploy |

Headers are the contract. Nothing writes by column index, so reordering columns in the
sheet is harmless. Renaming one is not, and `load()` will say which column went
missing.

### Approving a send

Check APPROVE on an Outreach row. The next run sends it, writes `sent_at` and
`message_id`, and never touches it again. Unchecking the box afterwards changes
nothing, because `sent_at` is what gates eligibility, not the checkbox.

A row that fails to send keeps the error text and is not retried automatically. Clear
the error cell to make it eligible again.

Set `Config.pause` to `TRUE` to run everything except sending.

## Tuning the rubric

Edit `config/profile.md`, then:

```bash
npm run replay -- --limit 25 --dry-run
```

This re-classifies existing Posts rows against the edited rubric without re-scraping,
and prints every verdict that changed. Leads and Outreach are never touched, so
nothing already drafted or sent is disturbed. Drop `--dry-run` to write the new scores.

## What this will and will not do

It surfaces postings and writes drafts. It is not a cold email machine.

Upwork hides client identity, so Upwork leads have no company, no domain and no
contact. They land on `manual_apply` with proposal text ready to paste. LinkedIn and
Indeed postings name a company but rarely a person, so contact enrichment there is a
"find someone at this company" problem rather than a "verify this address" one, and
vendors are weak at the first. Expect a minority of leads to become sendable email.
The rest arrive as a written draft and a link, which is still most of the work.

With `ENRICHMENT_PROVIDER=stub`, which is the default, no email is ever found and
nothing is sendable. That is correct behaviour until a vendor is chosen, not a bug.

## Scheduling

GitHub Actions, daily at 13:00 UTC, which is 06:00 in Arizona year round because
Arizona does not observe DST. Secrets go in repository settings.

Vercel Cron was in the original plan and was dropped. Serverless functions cap out
around five minutes; this pipeline runs Apify actors across roughly twenty queries per
source and takes far longer than that. Fitting it into Vercel would mean splitting the
run into a webhook-driven state machine for no gain.

Overlapping runs are blocked two ways: a `concurrency` group in the workflow, and a
mutex in the Config tab that goes stale after 30 minutes so a killed run cannot wedge
the next one.

## Cost control

Four limits, all editable in the Config tab:

- `max_items_per_query` bounds what the actors return
- `max_enrichments_per_run` bounds vendor spend on a bad query day
- `max_daily_cost` stops the run before enrichment if the estimate is already over
- `max_sends_per_day` bounds outbound volume

`api_cost_estimate` in the Runs row means different things per backend, and the digest
says which. On `api` it is real dollars. On `claude_code` there is no bill at all and
the figure is the API-list equivalent of the quota consumed, which is the only
comparable number available; the real money in that row is Apify plus enrichment.
Either way it is an estimate, and the vendor dashboards are authoritative.

## Layout

```
config/     profile.md, queries.json, actors.json, scoring.json
src/
  sources/  one adapter per board, plus the declarative normalizer
  pipeline/ dedupe, classify, score, enrich, draft, send, digest
  sheets/   schema.js is the single source of truth for every column
  providers/ anthropic, gmail, debounce, enrichment interface
  lib/      hash, log, retry, apify
scripts/    setup-sheet, run-once, replay, probe-actor
test/       unit tests and fixtures
```

## Notes on the build

Three things differ from the original spec, each for a stated reason:

1. **GitHub Actions instead of Vercel Cron**, because of the runtime ceiling above.
2. **A `PostsRaw` tab**, because `replay` cannot re-classify without the description
   text, and the specified Posts columns do not include it.
3. **Three added Posts columns.** `dupe_hash` persists the near-duplicate key so
   cross-posts are caught across runs rather than only within one. `last_classified_run`
   distinguishes a stale classification from a fresh one. `comp_flags` carries
   `comp_unknown` without polluting `fit_reasons`.
4. **Headless Claude Code as the default model backend**, so the pipeline runs on an
   existing Claude subscription instead of a second bill. The Messages API backend is
   complete and one environment variable away.
5. **A pre-filter stage** between normalize and classify, described above.

Sampling parameters were removed from current Claude models, so the classifier is not
run at temperature 0. Determinism comes from the JSON schema plus a fixed prompt,
enforced server-side on the API backend and validated with zod on the subscription
backend.
