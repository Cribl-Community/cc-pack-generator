# Cribl Pack Generator

Build and deploy a Cribl Stream Pack from a sample of your logs: parsing, field mapping to your SIEM's schema, a route and your sample, deployed to a worker group and scored on it.

## What this app does

- **Builds packs.** Pick a sourcetype and give it sample events, and choose one or more destination formats. The app deploys a pack with a pipeline per format. Known source and format pairs come from tested golden specs with no AI. Anything else is mapped by AI and checked against the same field model.
- **Scores them on your worker group.** It runs your sample through the deployed pipeline, scores the output by value coverage, and repairs a pipeline that scores below the target.
- **Batch mode.** Builds up to 200 pipelines from a CSV and keeps going after you close the tab.
- **Whiteboards & architecture** (optional, for Cribl and partner teams). A discovery board drawn with a prospect, an architecture drawing of the proposed Cribl deployment, and a demo environment built from them. See [Whiteboards and architecture](#whiteboards-and-architecture).

**For** Stream administrators and pipeline builders onboarding a log source, and Cribl and partner engineers running discovery. **Runs on** Cribl.Cloud, or a self-managed Leader with App Platform enabled. It deploys to Stream worker groups (not Edge fleets) and optionally uses Cribl Search and Cribl Lake.

## When to use this app

- You onboard a new log source and want a working pack without writing the pipeline by hand.
- You need many packs at once (batch mode).
- You run a discovery call and want the board, the proposed architecture and a demo in one place.

It is a starting point: review the pipeline before production data goes through it.

## Before you install

- App Platform enabled, and a Cribl role that can manage packs on the target worker group. Optional features need more: Search for datasets and dashboards, Lake for score logging and demos.
- For anything outside the golden specs: AI configured in **Settings → AI Settings** in Cribl. The app holds no AI key of its own.
- No other accounts or services are needed.

## Installation

1. In Cribl, open **Apps → Cribl Marketplace** and install **Cribl Pack Generator**. Or use **Add App → Import from Git** with `https://github.com/Cribl-Community/cc-pack-generator` and ref `latest`, or **Import from File** with the `.tgz` from the [latest release](https://github.com/Cribl-Community/cc-pack-generator/releases/latest).
2. Review the permissions it asks for (below) and install.
3. Grant access under **Apps → Cribl Pack Generator → Settings → Members & Teams**.

## Configuration

No setting is needed to start: the golden path works straight away. Every setting is stored per app, so it applies to everyone who can open the app.

| Setting | Where | Default |
|---|---|---|
| AI provider | Cribl **Settings → AI Settings** (outside the app) | Your org's provider. The installed app cannot use another one. Choose a fast model: every AI call must answer within the platform proxy's 30 s. |
| Require sanitised samples before any AI call | **Samples → Sharing** | Off. Turn it on if raw events must never reach your AI provider. |
| Golden thresholds, dropping null JSON fields | **Settings → Quality** | 80 per stage; off |
| Shared golden pool and reviewed vendor field lists | **Settings → Goldens** | The public pool (read-only) |
| Whiteboards & demos | **Settings → Menu** | Hidden |

## How to use

1. **Build pack flow:** choose the worker group, then the source (paste, upload, a worker-group sample, live capture, or a catalog sample; your own events give the most accurate pack). Then the destination formats, and review the mapping.
2. **Build:** the app creates the pack, pipelines, route and sample, commits and deploys only its own changes, and scores the result.
3. **Results:** shows whether the pack is live, the score per destination, and a link to open each pipeline in Stream.

First run: pick a worker group, choose **Check Point Firewall** under *Start from a catalog sample*, choose OCSF, and build. You get a deployed pack with a scored OCSF pipeline.

**Batch mode:** upload a CSV with `sourcetype`, `pack_name`, `pipeline_name` and `dest_format` (optionally `route_name`, `filter`). Rows that share a pack deploy in order, then every pipeline is scored.

**Supported formats:** OCSF 1.9, CEF, Microsoft Sentinel native tables and ASIM, Splunk CIM 5.x, Elastic ECS 8.x, Google Chronicle UDM, Cortex XSIAM, CrowdStrike NG SIEM, passthrough and clean JSON.

## Whiteboards and architecture

Turn them on in **Settings → Menu**, then open **Whiteboards & demos** under *Tools*. There is one row per prospect.

- **Whiteboard:** draw the prospect's estate (sources, tools, Cribl Lake, the Lakehouse Engine, Cribl Detect) on the Cribl platform picture. Type what hurts (**Pain**, or `/`) and the app finds the matching situation, what it becomes with Cribl and its business outcomes. **+ Security goals** and **+ Observability goals** record their initiatives. **Logo** looks the company up on Wikidata.
- **Architecture:** the second tab. Draw the proposed deployment (leader, worker groups, Edge fleets, Lake, Search, Detect) or use **Draw it from the whiteboard**. Export it as PNG, PDF or SVG.
- **Demo:** **Deploy demo** creates a demo environment from the board on a worker group: its own sources, destinations and Lake dataset, named per board, removed by demo cleanup.
- **Moving a board:** **Export → JSON file** and **Import saved whiteboard** move a board, with its architecture, to another org.

The full walkthrough is in the app under **Documentation → Whiteboards & demos**.

## Permissions and external access

Cribl API permissions (`config/policies.yml`). The test `tests/policy-coverage-test.mjs` checks both ways: every call is granted, and every grant has a caller. The only exceptions are reads on items the app writes, because the platform resolves a write against what the caller can read.

| Permission | Methods | Why |
|---|---|---|
| Packs (`/m/*/packs`, `/m/*/packs/*`) | GET, POST, PUT, DELETE | Upload, install and replace the generated pack. DELETE only removes a pack whose author is the Pack Generator, after the new one is uploaded. |
| Pack pipelines, routes, preview, samples, lookups (`/m/*/p/*/…`) | GET, POST, PATCH, DELETE | Write the pipelines, route, sample and lookups, run the sample through them, and remove a pack sample. |
| Group samples and live capture (`/m/*/system/samples…`, `/m/*/system/capture`) | GET, POST, PATCH, DELETE | Read and save worker-group samples, and capture live events. |
| Sources, destinations and group routes (`/m/*/system/inputs…`, `/m/*/system/outputs…`, `/m/*/routes…`) | GET, POST, PATCH, DELETE | Only the optional datagen source and demo environments, which create, toggle and remove their own. |
| Search datasets, datatypes and dashboards (`/m/*/search/…`) | GET, POST, PATCH | Optional, when the output goes to Search. |
| Lake datasets (`/products/lake/lakes/*/datasets…`) | GET, POST, DELETE | Score logging and the demo's dataset. |
| Version and deploy (`/version`, `/version/status`, `/version/commit`, `/master/groups/*`, `/master/groups/*/deploy`) | GET, POST, PATCH | Commit only the app's own changes, then deploy them. A deploy needs read access to its group. |
| Groups and workers (`/master/groups`, `/master/workers`) | GET | List worker groups, and their workers for the architecture drawing. |
| Backend schedules (`/backend-schedules…`) | POST, DELETE | Keep a batch running after the tab closes, and remove the schedule when it ends. |
| Cribl AI (`/ai/q/agents/open_investigator`) | POST | Every AI step, through your org's AI Settings. |

A generated pipeline uses only the 16 functions the generator builds. A golden or AI answer with any other function (`tee`, `redis`, `chain`, …) is refused before deploy.

External hosts (`config/proxies.yml`), reached only through the Cribl platform proxy. All are GET only, path-limited, and send no credential:

| Host | Paths | Why |
|---|---|---|
| `api.github.com`, `raw.githubusercontent.com` | The public golden and sample pools, and four public vendor-log repositories | Read shared goldens and sample sources |
| `www.wikidata.org`, `commons.wikimedia.org` | `/w/api.php` | Look up a prospect's logo by name (whiteboard **Logo** only) |
| `upload.wikimedia.org`, `thumb.wikimedia.org` | `/wikipedia/commons/…` | Download the chosen logo |
| `icon.horse` | `/icon/` | A website's icon, when you type a website instead |

Wikidata and the icon service receive only the company name or website you type, and only when you open the logo dialog. There are no AI provider hosts: AI goes through Cribl.

## Data and storage

- **Your worker group** keeps what the app deploys: packs, pipelines, routes, samples, lookups, and demo sources, destinations and datasets. They are normal Cribl objects and stay if you uninstall the app.
- **The app's KV store**, readable by anyone who can open the app:

  | Keys | Holds | Removed when |
  |---|---|---|
  | `settings/app` | Settings | You change them |
  | `wizard-draft/active` | The unfinished build, with its sample | The build finishes or you discard it |
  | `batch-run/active`, `batch-run/background` | Batch progress, with its samples | You dismiss the run |
  | `goldens/index`, `goldens/doc/*` | Saved and imported goldens | You delete them on the Goldens page |
  | `sanitised-samples/overlay`, `datatype-parsers/overlay`, `vendor-fields/seen` | Sanitised samples, learned parsers and field names seen on your builds (never shared) | You remove them under Samples |
  | `vendor-fields/pool` | Reviewed vendor field lists imported from the shared pool | A newer import replaces them |
  | `batch-run/metrics` | Run time and peak memory of the last 500 background batch steps (no event data) | Oldest entries roll off |
  | `whiteboards/index`, `whiteboards/doc/*`, `whiteboards/arch/*`, `whiteboards/library` | Boards, architecture drawings, your own catalogue entries | You delete the board |

- **Secrets:** the app holds no AI key. A token field in **Settings** writes to the encrypted KV store, which is write-only: it is never read back to a browser.
- **Nothing is sent elsewhere** except AI requests to your org's provider (next section) and the external reads listed above.

## Responsible use of AI

| | |
|---|---|
| Service | Cribl AI (`/ai/q/agents/open_investigator`), which uses the provider and model your admins chose in **Settings → AI Settings**. The app cannot use any other. |
| Purpose | Parse and map sources that no golden covers, write a sample when you ask for one, repair a pipeline that scores low, suggest a sourcetype or destination format for an unmatched whiteboard row. |
| Inputs | Your sample events, their field names, the sourcetype and destination schema. For a whiteboard row: only that row's label, never the prospect's name or other rows. |
| Outputs | Pipeline functions, field mappings, sample events and suggestions. You review them before anything is deployed. They are stored only in the pack and in the app's KV. |
| Retention, location, subprocessors | Those of the provider in your org's AI Settings, under your agreement with Cribl. The app adds no other processor. |
| Training | The app sends nothing for model training or product improvement. |
| Minimising data | The golden path uses no AI, and source detection tries the local recognisers first. **Require sanitised samples** (off by default, your choice) keeps raw events out of every AI call, including detection. The built-in sanitiser replaces hosts, users, addresses and secrets in your browser, with no AI. |

## Security

- **Access:** the app acts with the signed-in user's Cribl session and role, so it can do no more than that user. Who can open it is set in **Members & Teams**.
- **Least privilege:** the grants above, tested both ways.
- **Secrets:** none are held in the browser or in the bundle; typed tokens go to encrypted, write-only KV.
- **Known vulnerabilities:** none open. `npm audit --omit=dev` reports 0 for the shipped dependencies.
- **Report a vulnerability** privately through [**Security → Report a vulnerability**](https://github.com/Cribl-Community/cc-pack-generator/security/advisories/new). Fix targets: Critical 10 days, High 4 weeks, Medium 12 weeks, Low 25 weeks.

## Support

- Issues and questions: [GitHub Issues](https://github.com/Cribl-Community/cc-pack-generator/issues). Security reports: see [Security](#security).
- Critical issues get an answer within 24 hours, Monday to Friday, during business hours (CET). Critical and high-severity bugs are fixed first.
- Maintained by Wilfred van der Linde with Simon Duchene and Shailendra Sadh (Cribl Solutions Engineering).

## Known limitations and troubleshooting

- The score measures value coverage on your sample. A small or unrepresentative sample gives a misleading score.
- Background batch rows run in a Backend Function declared with a 600 s timeout and 256 MB. Measured on two batches (10 and 40 OCSF pipelines, 137 invocations, 2026-11-10): p95 run time 160 s (27 % of the timeout), longest 239 s, peak memory 140 MB (55 %). Each run measures itself (`batch-run/metrics` in the app's KV, timings only); a stage that runs out of time is checkpointed and resumes on the next tick.
- Publishing goldens to the shared pool only works when the app runs standalone.

| Symptom | Fix |
|---|---|
| `Request timeout` on an AI step | The platform proxy stops a request after 30 s. Choose a faster model. |
| Deploy returns 403 | Your role cannot manage packs on that worker group. |
| An empty pipeline after deploy | Deploy again: the app re-applies the functions when an import comes up empty. |
| Score 0, every event dropped | A filter dropped every event. Check the pipeline's filters against your sample. |
| No logo results on a whiteboard | An admin removed the Wikidata or Wikimedia hosts from the app's proxy list. Type a website or upload an image. |

## Release notes

- **1.0.335:** the background batch function may run 600 s (a heavy OCSF mapping needed more than 300 s), and it records its own run time and memory; measured p95 160 s and peak 140 MB on two test batches. *Check what we can demo* keeps **Continue** and the source list's **Done** on screen. Reviewed vendor field lists come from the shared pool like the goldens (Home offers them; **Settings → Goldens → Vendor field lists**). Only lists checked against the vendor documentation are offered, and field names seen on your builds are never shared.
- **1.0.326:** Whiteboards & demos and the Architecture drawing ship in the public build (hidden until you turn them on); a new whiteboard opens without the People row, and names the prospect's estate *Solution first* and *Platform first*. Check Point and other CEF events exported as JSON are recognised offline. Certificate names (`CN=…,O=…`) are sanitised part by part. A test now checks that every permission has a caller, and the product tags now include Search and Lake. This README documents every external host, KV key and AI input.
- **1.0.310:** every Cribl call is granted. A deploy commits only the app's own changes and never deletes a pack the Pack Generator did not make. Pipelines are limited to the generator's own functions. AI goes through Cribl AI Settings only.
- **1.0.309:** the home banner no longer offers shared goldens this install already has.
- **1.0.307:** sanitising never renames a JSON field. A replacement that would change a sample's structure names the line and the replacement to untick.
- **1.0.303:** first release in the Cribl app catalog.

## Running it locally

```bash
npm ci
npm run dev
```

Open http://localhost:5173. Standalone mode reads `CRIBL_ORG`, `CRIBL_CLIENT_ID`, `CRIBL_CLIENT_SECRET` and an AI endpoint from `.env` (see `.env.example`). `npm run package -- --version X.Y.Z` builds `build/cc-pack-generator-X.Y.Z.tgz`.

## Contributing, licence, authors

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). This repository is generated from the development repository, so a maintainer ports an accepted change and it ships in the next release. `npm test` runs the bundled tests.

Apache-2.0. The bundled secret-detection rules are MIT-licensed (`config/bundled-secret-rules-NOTICE`). The sample pool's terms are in `config/samples-pool-NOTICE`.

Built by Wilfred van der Linde, Simon Duchene and Shailendra Sadh, Cribl Solutions Engineering.
