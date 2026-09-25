# @pipeworx/eu-ctis

Clinical trials authorised in the EU/EEA under Regulation 536/2014, from the EU Clinical Trials Information System (CTIS) — who is running what, in which member states, for which condition, and at what status.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `ctis_search_trials(query?, medicine?, condition?, sponsor?, title?, endpoint?, exclude?, status?, phase?, country?, age_group?, region?, gender?, has_results?, rare_disease?, orphan_designation?, low_intervention?, start_from?, start_to?, sort_by?, sort_direction?, page?, limit?)` — the full search surface. Answers "which European trials are recruiting for this drug".
- `ctis_trial(ct_number)` — the full published record for one trial: title, sponsor, products and active substances, conditions, objective, eligibility criteria, endpoints, planned enrolment, per-member-state status and decision dates, and the reported start/recruitment events.
- `ctis_trials_for_medicine(medicine, recruiting_only?, country?, limit?)` — every EU trial involving a named medicine or active substance, counted by status.
- `ctis_recent_authorisations(since?, country?, condition?, sponsor?, phase?, limit?)` — trials most recently authorised in the EEA, newest decision first.

## Auth

Keyless. No API key, no cookie, and no browser User-Agent is required.

## Data sources

- `POST https://euclinicaltrials.eu/ctis-public-api/search` — the search endpoint, JSON body in and out.
- `GET https://euclinicaltrials.eu/ctis-public-api/retrieve/{ctNumber}` — one trial's full record.
- Public portal for humans: <https://euclinicaltrials.eu/ctis-public/search>.

### Things worth knowing before you touch this

- **A GET on `/ctis-public-api/search` answers 403.** Searching is a POST. The 403 is a method mismatch, not an authorisation wall — which is exactly what it looks like from the outside, and is why this source was written off once already.
- **Sibling paths answer 200 with HTML.** `/ctis-public-api/search/{ctNumber}`, `/trial/{ctNumber}` and `/ct/{ctNumber}` all return the Angular SPA's index page with a 200. Only `/retrieve/{ctNumber}` returns JSON. A parser that trusts the status code will parse an HTML shell as data.
- **An unknown trial number returns `{}` with a 200**, not a 404. The absence of `ctNumber` in the body is the only "not found" signal there is.
- **Filters are numeric code lists, not text.** `status`, `trialPhaseCode`, `ageGroupCode`, `msc` (member states, as ISO 3166 *numeric* country codes) and `trialRegion` all take integers. The vocabularies are in `src/index.ts`, lifted from the portal's own option lists; the tools accept the human labels and map them.
- **The overall status code and the per-country status code share one vocabulary** (1 = under evaluation … 12 = cancelled, plus 13–18 used per member state). `trialCountries` in a search row is `"Spain:2"` — country name, colon, that country's status code.
- **`ctStatus` means two different things.** In a search row it is the numeric code; in a retrieve payload it is a coarser label string ("Authorised") and the numeric lives in `ctPublicStatusCode`. Both are normalised to a label on the way out.
- **Dates differ by endpoint**: search rows are `DD/MM/YYYY`, detail is an ISO timestamp. Everything comes out as an ISO date.
- **A full record is large** — 220 KB for a 16-country phase III — because every free-text field carries a translation into every concerned language. The detail tool flattens and drops the translations.
- **Trials carry their ClinicalTrials.gov number** in `secondaryIdentifyingNumbers.nctNumber`, exposed as `nct_number`. That is the join key to the `clinicaltrials` pack for the same study.
- **CTIS starts in 2022.** Regulation 536/2014 applies from 31 January 2022; trials authorised under the old Directive live in the legacy EU Clinical Trials Register and are not here.
- `trialGlobalEnd` is an array while a trial is running and an object once it has ended.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "eu-ctis": {
      "url": "https://gateway.pipeworx.io/eu-ctis/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/eu-ctis/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ctis_search_trials \
  -H 'Content-Type: application/json' \
  -d '{"medicine":"pembrolizumab","status":["Ongoing, recruiting"],"country":["Germany"],"limit":2}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ctis_search_trials`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "eu-ctis": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-eu-ctis"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-eu-ctis
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Eu Ctis data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
