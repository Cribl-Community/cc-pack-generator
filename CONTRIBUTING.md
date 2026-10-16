# Contributing

Issues and pull requests are welcome here.

## This repository is generated

Every file here is generated from the Pack Generator's development repository, and each release replaces the whole tree. So a pull request is not merged here directly. A maintainer ports the change to the source, and it ships in the next release, with you credited as co-author. The pull request gets a comment that links to that release.

## Before you open a pull request

```bash
npm ci
npm run lint
npm test
npm run build
```

`npm test` runs the tests in `tests/`. They cover the parsers, the destination format contracts, schema conformance, scoring and the sample sanitiser, and they run on every pull request.

Keep changes deterministic where they can be. A known sourcetype and destination pair is built from golden format specs, without AI. AI is only the fallback.

## Reporting a bad pipeline

Open an issue with the sourcetype, the destination format, the score the app showed, and a few sample events. **De-identify the samples first**: replace host names, user names, IP addresses and anything else that identifies your environment. The app's **Sanitize** step can do this for you.
