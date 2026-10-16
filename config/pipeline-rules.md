# Pipeline Generation Rules

Hard-won rules for generating correct multi-stage Cribl Stream pipelines.
Loaded into AI prompts during pipeline generation and repair.
Learned from 14 professional Cribl packs (Brendan Dalpe, David Maislin, Jon Rust,
Raanan Dagan, Jim Apger, Igor Gifrin, Christoph Dittmann, Kam Amir) + live debugging.

---

## Rule 1: Field Lifecycle — Map from the Correct Stage

In a multi-stage pipeline (parse → normalize → mapping → cleanup), each stage
transforms field names. The mapping stage MUST reference field names as they
exist AT THAT POINT in the pipeline — not the raw source names.

Example (FortiGate CEF):
- Raw CEF extension: `spt=443 dpt=80 act=accept FTNTFGTduration=120`
- After KVP extract: `spt`, `dpt`, `act`, `FTNTFGTduration`
- After FTNTFGT strip: `spt`, `dpt`, `act`, `duration`
- After normalize: `src_port`, `dst_port`, `action`, `duration`

If mapping references `FTNTFGTduration` but normalize already stripped the
prefix → field doesn't exist → empty output.

**Best practice:** Map directly from post-KVP/post-prefix-strip field names.
Skip the normalize intermediate when possible — it creates name collisions.

## Rule 2: Cleanup — Use Keep-List, Not Remove-List

Professional packs almost universally use `keep: [...]` + `remove: ['*']`
instead of enumerating fields to remove. This is safer against schema drift
(new source fields won't leak through).

```
{ id: "eval", conf: { keep: ["_time","_raw","src_ip","dest_ip",...], remove: ["*"] } }
```

If a keep-list isn't feasible, compute the remove list dynamically:
```
removeList = ALL_RAW_FIELDS.filter(f => !outputFieldsFromMapping.has(f))
```

**Critical:** never run a wildcard `remove('*')` BEFORE a serialize step that
still needs to read those fields.

## Rule 3: Cribl Eval Expression Constraints

`jsExpression` (eval `add.value`) accepts ONE expression only:
- Forbidden: `=>`, `function`, `return`, `;`, `?.`, `??`, IIFE, statements
- Allowed: ternaries, `||` chains, `.match()`, `new Date(...)`, Number/String/Math
- Field names must be valid JS accessor paths (no `@`, hyphens, spaces, leading digits)
- Reserved word fields (like `in`) must use `__e['in']` syntax

## Rule 4: Match Parse Function to Wire Format

Never force one parse approach on all data:
- **JSON sources** (CloudTrail, structured APIs): `serde` type=json, or skip parse entirely if connector already delivers objects
- **KV syslog** (FortiGate, many firewalls): `serde` type=kvp with correct delimiters — never regex_extract KV data
- **CSV/positional** (Palo Alto, VPC Flow): `serde` type=csv/elff after stripping the syslog header
- **Unstructured text** (Cisco ASA/FTD, syslog): `regex_extract` with named groups, one per pattern
- **XML** (Windows Events): `C.Text.parseWinEvent(_raw, ['0x0','0','-'])`, followed by `flatten` and `rename`; never regex against tags

## Rule 5: Timestamp Extraction

Prefer the native `auto_timestamp` function over manual eval-based Date parsing.
Only use manual extraction when the format is non-standard.

FortiGate `eventtime` is nanoseconds epoch (19 digits). Extract seconds:
```
eventtime ? Number(String(eventtime).substring(0, 10)) : _time
```

General rule: always add a per-event `_time` extraction. Static timestamps
(all events same `_time`) are a high-severity validator finding.

When timezone is ambiguous (syslog without TZ offset), use a per-host timezone
lookup or heuristic — never blindly assume UTC.

## Rule 6: One Pipeline Per Subtype, Route Upstream

When a vendor emits multiple structurally different log subtypes (FortiGate
traffic/utm/event/dns, Palo Alto traffic/threat/system), create ONE PIPELINE
per subtype with routing handled at the Route/QuickConnect layer.

For schema mapping (same source → multiple destinations like CIM + ECS + OCSF):
parse once in a base pipeline, then use the `chain` function to fan out to
schema-mapper pipelines — never duplicate parse logic.

## Rule 7: Normalization via Lookups, Not Hardcoded Chains

Cross-schema field renaming and value normalization should be externalized to
CSV lookup tables:
- Protocol: `proto` number → name (tcp/udp/icmp) via lookup
- Action: vendor action → schema action (accept→allowed) via lookup  
- Severity: vendor level → standard severity_id via lookup

This decouples data from logic — users can edit the CSV without touching pipeline code.

Build normalization key → lookup → discard key pattern:
```
eval: ftnt_action = utmaction || action || status
lookup: ftnt_action → cim_action (from ftnt_cim_action.csv)
eval: action = cim_action; remove ftnt_action
```

## Rule 7b: Lookup-DRIVEN Parsing — Build for Full Coverage, Not Just the Samples

When a golden parsing lookup exists (e.g. `cisco_asa_parsing.csv` with 184
per-code regexes, `cisco_ftd_parsing.csv` with 168), the sample events only show
a HANDFUL of the codes. Do NOT hardcode regex_extract for just the sampled codes.
Instead build lookup-driven parsing that covers EVERY code in the lookup:

1. Extract the event/message code with one eval (or regex_extract).
2. Lookup the code against the parsing CSV to fetch its per-code regex string
   into a scratch field (e.g. `__regex`).
3. Apply that regex dynamically in an eval and spread the named groups onto the
   event.

Proven working config (verified against cribl-cisco-asa-cleanup):
```
eval:   asa_code = _raw.match(/%(?:ASA|FTD)-\S*-(\d+):/) ? _raw.match(/%(?:ASA|FTD)-\S*-(\d+):/)[1] : null
lookup: file=cisco_asa_parsing.csv, matchMode=exact, addToEvent=false,
        inFields=[asa_code→asa_code], outFields=[regex→__regex]
        ⚠️ DO NOT set matchType — matchType:'first' BREAKS the regex-column lookup.
eval:   filter "__regex && _raw.match(__regex)"
        add: groups = _raw.match(__regex).groups
        add: (empty name) = Object.assign(__e, groups)
        remove: [groups, __regex]
```

The full parsing CSV is auto-bundled into the pack's `data/lookups/` at deploy
(see lookup-bundler.mjs). This is superior to per-format hardcoded regex because
it covers all documented codes and stays editable without touching pipeline code.

## Rule 8: Noise Reduction Strategies

Ordered by impact (apply these in generated pipelines):
1. **Drop worthless events** — zero-byte sessions, keepalives, health checks, NODATA placeholders
2. **Drop by lookup flag** — CSV with event codes/subtypes marked for drop (decouples data from logic)
3. **Suppress high-frequency repeats** — `suppress` with composite key + time window, fold count back in
4. **Filter internal traffic** — `C.Net.isPrivate(src) && C.Net.isPrivate(dst)` for allowed east-west
5. **API audit log trimming** — drop read-only/describe/list calls (Get*/List*/Describe* in CloudTrail)
6. **DNS popularity filter** — suppress queries to top-N domains via lookup
7. **Sampling** — statistical thinning for very-high-volume-but-not-worthless categories

Use `final: true` aggressively on early guard conditions (wrong input type,
unparseable event) for performance.

## Rule 9: Field Naming Conventions

Target schemas diverge sharply — never assume one universal standard:
- **CIM (Splunk):** `src_ip`, `dest_ip`, `dest_port` (note: `dest_` not `dst_`)
- **ECS (Elastic):** `source.ip`, `destination.ip`, `destination.port` (dotted)
- **OCSF:** `src_endpoint.ip`, `dst_endpoint.ip`, numeric UIDs for class/category
- **CEF/Sentinel:** `src`, `dst`, `spt`, `dpt` (CEF short names)
- **Vendor native:** varies (FortiGate uses `srcip`, Palo Alto uses positional)

When no target schema is specified, default to CIM snake_case as the canonical
intermediate form.

## Rule 10: No Duplicate Field Semantics

Never keep two redundant representations of the same value in final output:
- Bad: `bytes_in=168` AND `rcvd_bytes=168` (redundant)
- Bad: `severity=5` AND `severity_name="high"` (keep only the schema-required one)
- Good: only the target schema field name

## Rule 11: Double-Underscore for Scratch Fields

Prefix every intermediate/working field with `__` (double underscore):
- `__kvp_src`, `__cef_ext`, `__parse_tmp`
- These are automatically cleaned up by `remove: ['__*']`
- Never use unprefixed names for intermediates — they leak into output

## Rule 12: IPv6 Handling

CEF uses `c6a2` (source IPv6) and `c6a3` (destination IPv6) when no IPv4 `src`/`dst`.
Mapping must fall through: `src || c6a2 || ''` to catch IPv6-only events.

## Rule 13: Protocol and Action Normalization

- Protocol: map numeric codes to names (`6`→`tcp`, `17`→`udp`, `1`→`icmp`)
- Action: map vendor-specific values to schema values:
  - CIM: `accept`→`allowed`, `deny`→`blocked`, `close`→`allowed`, `client-rst`→`blocked`
  - OCSF: uses `activity_id` integers (1=open, 5=refuse)

## Rule 14: Direction Derivation

FortiGate interface roles indicate direction:
- `srcintfrole=wan` + `dstintfrole=lan` → `inbound`
- `srcintfrole=lan` + `dstintfrole=wan` → `outbound`
- `srcintfrole=lan` + `dstintfrole=lan` → `internal`
- `subtype=local` → `internal`
- `subtype=forward` + no wan → `outbound`

## Rule 15: Comment Functions for Documentation

Emit `comment` functions at the start of generated pipelines and before major
stage groups:
```
{ id: "comment", conf: { comment: "Pipeline: FortiGate-CIM\nPurpose: Map to Splunk CIM\nCoverage: Network_Traffic, Authentication" } }
```

## Rule 16: Groups for Logical Structure

Use `conf.groups` metadata to bundle related functions into named, toggleable
stages:
```
conf.groups = { parse: { name: "Parse", order: 1 }, noise: { name: "Noise Reduction", order: 2 }, map: { name: "Schema Mapping", order: 3 } }
```
Each function references its group via `groupId: "parse"`.

---

## Anti-Patterns (NEVER do these)

1. Never use `code` functions for parsing — reserved only for narrow utility tasks (XML EventData extraction, CEF custom-field bucketing)
2. Never use `serde`/JSON.parse on non-JSON text logs
3. Never hardcode per-event-type if/else regex chains — use lookup-driven dynamic patterns
4. Never enumerate a remove-list when keep-list + `remove:['*']` works
5. Never assume one universal field-name schema across targets
6. Never keep two redundant representations of the same value
7. Never leave test/debug artifacts (hardcoded credentials, dangling eval) in pipelines
8. Never assume UTC for ambiguous syslog timestamps without detection/lookup
9. Never parse XML with regex-against-tags when a parse helper is available
10. Never mix two incompatible cleanup strategies (serialize+wildcard vs keep-flat) in chained pipelines

---

## Validator Score Expectations

- Score >= 85: good (all standard fields mapped correctly)
- Score 70-84: acceptable for sparse source data (not all event types have
  all fields — e.g., ICMP traffic has no ports/user)
- Score < 60: structural issue (wrong field names, broken expressions, fields deleted)
