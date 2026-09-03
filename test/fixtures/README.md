# Fixtures

These are hand-authored, not captured from live actor runs. apify.com was not
reachable from the environment this project was built in, so no actor output could be
recorded and no actor's real field names could be confirmed.

What that means in practice:

- The tests here prove the mapping layer works. They do not prove the mappings in
  `config/actors.json` match the actors.
- Before trusting a live run, run `npm run probe-actor -- <source>` with `APIFY_TOKEN`
  set. It saves real output to `.probe/<source>.json` and prints which mapped fields
  resolve against it.
- Then replace these files with the real payloads and re-run `npm test`. A failing
  test at that point is the mapping being wrong, which is exactly what you want to
  find out before a scheduled run does.
