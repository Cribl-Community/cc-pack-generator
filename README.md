# Cribl Pack Generator

Build and deploy a Cribl Stream Pack from a sample of your logs. Pick a sourcetype, give the app some sample events, choose one or more destination schemas, and it deploys a pack with parsing, field mapping and destination shaping to your worker group.

- **Deterministic where it can be.** Known sourcetype and destination pairs are built from golden format specs, with no AI involved. Everything else falls back to AI mapping, checked against the same canonical field model.
- **Scored on your worker group.** After a pipeline is published, the app runs your sample through it and scores the output by value coverage. A pipeline below the target is repaired automatically.
- **Reusable.** A good pipeline is saved as a golden that you can reuse and import from a shared pool.

## When to use this app

Use it when you onboard a new log source into Cribl Stream and want a working pack (parsing, field mapping to your SIEM's schema, and a route) without writing the pipeline by hand, or when you need many packs at once (batch mode). It is a starting point: review the pipeline it builds before you send production data through it.

## Before you install

- A Cribl Cloud workspace (or a Leader) with App Platform enabled.
- A Stream worker group to deploy to, and a Cribl role that can manage packs there.
- For anything outside the golden specs: an AI provider, either your org's **Cribl AI Settings** or an API key for one of the providers below.

## Installation

1. In Cribl, open **Apps** and find **Cribl Pack Generator** in the app catalog. You can also use **Add App → Import from Git** with `https://github.com/Cribl-Community/cc-pack-generator` and the ref `latest`, or install the `.tgz` from the [latest release](https://github.com/Cribl-Community/cc-pack-generator/releases/latest) with **Import from File**.
2. Review the API permissions the app asks for and install it.
3. Grant access under **Apps → Cribl Pack Generator → Settings → Members & Teams**.
4. Open the app and, under **Settings**, choose an AI provider (see below).

## Configuration

### AI provider

The golden path needs no AI. For AI-assisted parsing, mapping and sample generation, choose a provider under **Settings**. **Cribl AI Settings** uses the AI provider your org already has configured in Cribl, with no key needed. You can also add an API key for Anthropic, OpenAI, Google Gemini, Mistral, Azure AI or AWS Bedrock.

Choose a fast model. Every AI call has to answer within the platform proxy's 30-second limit, and this work is structured extraction rather than deep reasoning.

## How to use

1. **Worker group**: choose the Stream worker group to deploy to.
2. **Sourcetype**: pick one from the catalog or type your own. The app can detect it from your samples.
3. **Samples**: upload a file, paste events, capture live from the worker group, or use a bundled sample. Real vendor logs are always preferred over AI-generated ones.
4. **Destination format**: OCSF 1.9, CEF, Microsoft Sentinel (a specific native table), Splunk CIM, Elastic ECS, Sentinel ASIM, Google Chronicle UDM, Cortex XSIAM, CrowdStrike NG SIEM, Passthrough or clean JSON. Each format you pick gets its own pipeline.
5. **Review**: check the destination shaping and the schema mapping.
6. **Deploy**: the app creates the pack, pipelines, route and samples on your worker group.

Your sample is included in the pack, so you can use it for preview and testing.

### Batch mode

Upload a CSV with the columns `sourcetype`, `pack_name`, `pipeline_name` and `dest_format`, and optionally `route_name` and `filter`. The app builds each row, deploys the rows that share a pack in order, and then scores every pipeline. Batch runs continue in a Backend Function, so closing the browser tab does not stop them.

## Supported formats

| Format | Target |
|---|---|
| OCSF | Open Cybersecurity Schema Framework 1.9 |
| CEF | ArcSight Common Event Format |
| Microsoft Sentinel | Native tables (CommonSecurityLog, SecurityEvent, Syslog and 47 more) |
| CIM | Splunk Common Information Model 5.x |
| ECS | Elastic Common Schema 8.x |
| ASIM | Microsoft Sentinel ASIM |
| Chronicle UDM | Google Chronicle Unified Data Model |
| Cortex XSIAM | Source-native passthrough with `__sourceIdentifier`, `__vendor` and `__product` |
| CrowdStrike NG SIEM | The original event, for the connector's vendor parser |
| Passthrough | The raw event, unchanged |
| JSON | Clean, normalized JSON for Cribl Lake, S3 or Splunk HEC |

## Permissions and external access

The app asks Cribl for these API permissions (`default/policies.yml`):

- **Packs, pipelines, routes, samples and lookups** on a worker group: to create the pack, write its pipelines and route, and upload your sample and any reference lookups into it.
- **Preview** on a pack: to run your sample through the deployed pipeline and score the output.
- **Version commit and group deploy**: to commit and deploy what it created.
- **Search datasets, datatypes and dashboards**: optional, when you send the output to Cribl Lake or Search.
- **Backend schedules**: so a batch run continues after you close the tab.
- **Cribl AI** (`/ai/q/agents/open_investigator`): only when you choose **Cribl AI Settings** as the provider.

Delete permissions, and why:

| Path | Why |
|---|---|
| `/m/*/packs/*` | Re-deploying a pack replaces it: the old pack with the same id is removed first. |
| `/m/*/system/samples/*` | Replacing or removing a sample the app uploaded. |
| `/backend-schedules/*` | Removing a batch run's schedule when the run finishes or you cancel it. |

External hosts (`default/proxies.yml`), reached through the Cribl platform proxy:

- **AI providers**: `api.anthropic.com`, `api.openai.com`, `api.mistral.ai`, `generativelanguage.googleapis.com`, `models.inference.ai.azure.com`, `api.githubcopilot.com` and the AWS Bedrock regional endpoints. Each is used only if you choose it, and your API key is injected by the proxy from the app's encrypted store.
- **`raw.githubusercontent.com` and `api.github.com`**: read-only, unauthenticated reads of the public shared goldens and sample pool.

## Data and storage

- **On your worker group**: the packs, pipelines, routes, samples and lookups the app deploys. They are normal Cribl objects and stay if you uninstall the app.
- **In the app's own KV store**: your settings, goldens and batch progress. API keys are written encrypted and can only be read by the platform proxy, not by the app.
- **Sent to your AI provider**: when a step needs AI, the app sends sample events and field names to the provider you chose. Use the golden path or a sanitised sample if your events must not leave Cribl.
- **Nothing is sent anywhere else.** Shared goldens are only read; publishing to the shared pool is a maintainer action outside the app.

## Support

Open an issue in [this repository](https://github.com/Cribl-Community/cc-pack-generator/issues). It is maintained by Wilfred van der Linde (Cribl Solutions Engineering), who aims to fix critical security issues within 10 days and high ones within 4 weeks.

## Known limitations and troubleshooting

- Every AI request must answer within the platform proxy's 30-second limit.
- The score measures value coverage on your sample, so a small or unrepresentative sample gives a misleading score.
- Publishing goldens to the shared pool only works when the app runs standalone.

| Symptom | Fix |
|---|---|
| `Request timeout` on AI work | The platform proxy stops any request after 30 seconds. Choose a faster model. |
| Deploy returns 403 | Check that your Cribl role can manage packs on the target worker group. |
| An empty pipeline after deploy | Deploy again. The app re-applies the functions when a pack import comes up empty. |
| Score 0 with every event dropped | A filter or post-processing rule dropped every event. Check the pipeline's filters against your sample. |
| Golden publishing is unavailable | Publishing needs a server-side token, so it only works when the app runs standalone. Importing goldens works everywhere. |

## Release notes

- **1.0.304**: the Cribl-internal AI provider is no longer offered in this build; README covers permissions, data and support.
- **1.0.303**: first release in the Cribl app catalog. Shared goldens whose names contain `@` or `#` import inside Cribl.

## Running it locally

```bash
npm ci
npm run dev
```

Then open http://localhost:5173. Standalone mode reads Cribl Cloud API credentials (`CRIBL_ORG`, `CRIBL_CLIENT_ID`, `CRIBL_CLIENT_SECRET`) and an AI endpoint from `.env`. See `.env.example`.

`npm run package -- --version X.Y.Z` builds `build/cc-pack-generator-X.Y.Z.tgz`, which you can install with **Import from File**.

## Contributing

Issues and pull requests are welcome here. This repository is generated from the Pack Generator's development repository, so a maintainer ports an accepted change there and it ships in the next release. See [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` runs the bundled tests.

## Licence

Apache-2.0. The bundled secret-detection rules are MIT-licensed; see `config/bundled-secret-rules-NOTICE`. The shared sample pool's terms are in `config/samples-pool-NOTICE`.

## Author

Wilfred van der Linde, Cribl Solutions Engineering
