# Fixtures

`indeed.json` mirrors the real shape returned by `misceres/indeed-scraper`, build
0.0.108, captured from a live probe on 2026-09-07. The field names, the null
`postedAt` alongside a populated `postingDateParsed`, the `jobType` array and the
`isExpired` flag are all as the actor actually emits them.

`upwork.json` and `linkedin.json` are still hand-authored and prove only that the
mapping layer works. Neither actor has produced output yet:

- Upwork rejected the probe with `maxItems must be >= 20`. Re-probe now that the
  actor's floor is honoured.
- LinkedIn is a rental actor and returned `actor-is-not-rented`. It needs a paid
  monthly rental or a different actor.

To refresh any of them, run the `Setup and Probe` workflow with `probe-actors`. It
saves raw output under `.probe/` and uploads it as a run artifact.

A test failing after you replace a fixture means the mapping in
`config/actors.json` is wrong, which is exactly what you want to find out before a
scheduled run does.
