# Fixtures

`indeed.json` and `upwork.json` mirror the real shapes their actors emit, captured
from live probes on 2026-09-07:

- **Indeed** (`misceres/indeed-scraper`, build 0.0.108). Note `postedAt` is null on
  every item while `postingDateParsed` carries the value, `jobType` is an array, and
  `isExpired` is present. Every mapped field resolves at 100%.
- **Upwork** (`devcake/upwork-jobs-scraper`). Pay is split across `hourlyMin`,
  `hourlyMax` and `fixedAmount` with a `budget` string alongside; the date is
  `publishTime`; there is no company, no location and no hours field, only a text
  `duration` band. The $5 beta-reading row is real output, kept deliberately as the
  case that proves a fixed total below the hourly floor gets rejected.

`linkedin.json` is still hand-authored. That actor has not produced output yet: the
first attempt returned `Field input.queries is required`, which is now corrected but
unproven.

To refresh any of them, run the `Setup and Probe` workflow with `probe-actors`. Raw
output is saved under `.probe/` and uploaded as a run artifact.

A test failing after you replace a fixture means the mapping in `config/actors.json`
is wrong, which is exactly what you want to find out before a scheduled run does.
