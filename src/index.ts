interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * EU CTIS MCP — the Clinical Trials Information System, the EU's public register
 * of clinical trials authorised under Regulation 536/2014.
 *
 * Auth: none.
 *
 * Source shape (all of it measured 2026-08-25 against the live service, because
 * every published URL for this API is either wrong or absent):
 *  - The register is a JSON API behind the euclinicaltrials.eu SPA. Searching is
 *    `POST /ctis-public-api/search` with a JSON body. A **GET** on that same path
 *    answers 403, which is what makes it look gated when it is not — it is a
 *    method mismatch, not an authorisation wall.
 *  - Detail is `GET /ctis-public-api/retrieve/{ctNumber}`. Sibling paths
 *    (`/search/{id}`, `/trial/{id}`) answer 200 with the SPA's HTML shell, so a
 *    parser that trusts the status code reads an Angular index page as data.
 *  - No API key, no cookie, no browser User-Agent required.
 *  - Statuses, phases, age ranges and member states are numeric code lists. The
 *    labels below are lifted from the portal's own vocabulary, so a caller can
 *    say "ongoing, recruiting" or "Germany" instead of 4 or 276.
 *  - Search rows carry DD/MM/YYYY dates; detail carries ISO timestamps. Both are
 *    normalised to ISO dates on the way out.
 *  - A full trial record is large (220 KB for a 16-country phase III) and carries
 *    every field translated into every concerned language. Detail is flattened
 *    and the translations dropped.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'EU CTIS');
}

const API = 'https://euclinicaltrials.eu/ctis-public-api';
const PORTAL = 'https://euclinicaltrials.eu/ctis-public/view';
const SOURCE = 'EU Clinical Trials Information System (CTIS), European Medicines Agency';

/** Overall and per-country trial status codes, from the portal's own list. */
const STATUS_LABELS: Record<number, string> = {
  1: 'Under evaluation',
  2: 'Authorised, recruitment pending',
  3: 'Authorised, recruiting',
  4: 'Ongoing, recruiting',
  5: 'Ongoing, recruitment ended',
  6: 'Temporarily halted',
  7: 'Suspended',
  8: 'Ended',
  9: 'Expired',
  10: 'Revoked',
  11: 'Not authorised',
  12: 'Cancelled',
  13: 'Withdrawn',
  14: 'Lapsed',
  15: 'Not valid',
  16: 'Authorised',
  17: 'Pending',
  18: 'No mapped status',
};

const PHASE_LABELS: Record<number, string> = {
  1: 'Human pharmacology (Phase I) — first administration to humans',
  2: 'Human pharmacology (Phase I) — bioequivalence study',
  3: 'Human pharmacology (Phase I) — other',
  4: 'Therapeutic exploratory (Phase II)',
  5: 'Therapeutic confirmatory (Phase III)',
  6: 'Therapeutic use (Phase IV)',
  7: 'Phase I and Phase II (integrated) — first administration to humans',
  8: 'Phase I and Phase II (integrated) — bioequivalence study',
  9: 'Phase I and Phase II (integrated) — other',
  10: 'Phase II and Phase III (integrated)',
  11: 'Phase III and Phase IV (integrated)',
};

/** "phase 3" is what a caller says; 5 and 10 are what the register stores. */
const PHASE_SHORTHAND: Record<string, number[]> = {
  '1': [1, 2, 3, 7, 8, 9],
  '2': [4, 7, 8, 9, 10],
  '3': [5, 10, 11],
  '4': [6, 11],
};

const AGE_GROUPS: Record<string, number> = {
  'in utero': 1,
  '0-17': 2,
  '0-17 years': 2,
  children: 2,
  paediatric: 2,
  pediatric: 2,
  '18-64': 3,
  '18-64 years': 3,
  adults: 3,
  adult: 3,
  '65+': 4,
  '65+ years': 4,
  elderly: 4,
};

const REGIONS: Record<string, number> = {
  eea: 1,
  'eea only': 1,
  'non-eea': 2,
  'non-eea only': 2,
  both: 3,
  'eea and non-eea': 3,
};

/** ISO 3166 numeric ids, which is what the `msc` filter takes. EEA only. */
const COUNTRY_IDS: Record<string, number> = {
  austria: 40, at: 40,
  belgium: 56, be: 56,
  bulgaria: 100, bg: 100,
  croatia: 191, hr: 191,
  cyprus: 196, cy: 196,
  czechia: 203, 'czech republic': 203, cz: 203,
  denmark: 208, dk: 208,
  estonia: 233, ee: 233,
  finland: 246, fi: 246,
  france: 250, fr: 250,
  germany: 276, de: 276,
  greece: 300, gr: 300,
  hungary: 348, hu: 348,
  iceland: 352, is: 352,
  ireland: 372, ie: 372,
  italy: 380, it: 380,
  latvia: 428, lv: 428,
  liechtenstein: 438, li: 438,
  lithuania: 440, lt: 440,
  luxembourg: 442, lu: 442,
  malta: 470, mt: 470,
  netherlands: 528, nl: 528,
  norway: 578, no: 578,
  poland: 616, pl: 616,
  portugal: 620, pt: 620,
  romania: 642, ro: 642,
  slovakia: 703, sk: 703,
  slovenia: 705, si: 705,
  spain: 724, es: 724,
  sweden: 752, se: 752,
};

type Json = Record<string, any>;

function statusLabel(code: unknown): string | null {
  return typeof code === 'number' ? STATUS_LABELS[code] ?? `code ${code}` : null;
}

/** Search rows are DD/MM/YYYY; detail is an ISO timestamp. Both come out ISO. */
function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const dmy = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const iso = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : v;
}

async function apiPost(path: string, body: Json): Promise<Json> {
  const res = await pwFetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CTIS ${path} returned HTTP ${res.status}`);
  return (await res.json()) as Json;
}

async function apiGet(path: string): Promise<Json | null> {
  const res = await pwFetch(`${API}${path}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`CTIS ${path} returned HTTP ${res.status}`);
  const text = await res.text();
  // Unknown paths answer 200 with the SPA shell, so an HTML body means "no such trial".
  if (text.trimStart().startsWith('<')) return null;
  return JSON.parse(text) as Json;
}

function resolveList<T>(
  input: unknown,
  map: Record<string, T>,
  unknown: string[],
): T[] {
  const raw = Array.isArray(input) ? input : input == null ? [] : [input];
  const out: T[] = [];
  for (const item of raw) {
    const key = String(item).trim().toLowerCase();
    const hit = map[key];
    if (hit === undefined) unknown.push(String(item));
    else if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

function resolveStatuses(input: unknown, unknown: string[]): number[] {
  const raw = Array.isArray(input) ? input : input == null ? [] : [input];
  const out: number[] = [];
  for (const item of raw) {
    if (typeof item === 'number') {
      out.push(item);
      continue;
    }
    const want = String(item).trim().toLowerCase();
    const hit = Object.entries(STATUS_LABELS).find(
      ([, label]) => label.toLowerCase() === want || label.toLowerCase().startsWith(want),
    );
    if (hit) out.push(Number(hit[0]));
    else unknown.push(String(item));
  }
  return [...new Set(out)];
}

function resolvePhases(input: unknown, unknown: string[]): number[] {
  const raw = Array.isArray(input) ? input : input == null ? [] : [input];
  const out: number[] = [];
  for (const item of raw) {
    if (typeof item === 'number') {
      out.push(item);
      continue;
    }
    const want = String(item).trim().toLowerCase();
    const roman = want.replace(/^phase\s*/, '').replace(/\s+/g, '');
    const arabic = { i: '1', ii: '2', iii: '3', iv: '4' }[roman] ?? roman;
    const shorthand = PHASE_SHORTHAND[arabic];
    if (shorthand) {
      out.push(...shorthand);
      continue;
    }
    const hit = Object.entries(PHASE_LABELS).find(([, label]) => label.toLowerCase() === want);
    if (hit) out.push(Number(hit[0]));
    else unknown.push(String(item));
  }
  return [...new Set(out)];
}

/** "Spain:2" is country + per-country status code. */
function splitCountries(raw: unknown): { country: string; status: string | null }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const s = String(entry);
      const idx = s.lastIndexOf(':');
      if (idx < 0) return { country: s, status: null };
      return { country: s.slice(0, idx), status: statusLabel(Number(s.slice(idx + 1))) };
    })
    .filter((c) => c.country);
}

function compactRow(row: Json): Json {
  return {
    ct_number: row.ctNumber,
    title: row.ctTitle,
    status: statusLabel(row.ctStatus),
    sponsor: row.sponsor || null,
    sponsor_type: row.sponsorType || null,
    phase: row.trialPhase || null,
    conditions: row.conditions || null,
    therapeutic_areas: row.therapeuticAreas ?? [],
    products: row.product || null,
    countries: splitCountries(row.trialCountries),
    age_group: row.ageGroup || null,
    gender: row.gender || null,
    subjects_enrolled: row.totalNumberEnrolled ?? null,
    primary_endpoint: row.primaryEndPoint || null,
    decision_date: isoDate(row.decisionDateOverall),
    results_posted: row.resultsFirstReceived === 'Yes',
    last_updated: isoDate(row.lastUpdated),
    url: `${PORTAL}/${row.ctNumber}`,
  };
}

interface SearchOpts {
  criteria: Json;
  page?: number;
  limit?: number;
  sortProperty?: string;
  sortDirection?: 'ASC' | 'DESC';
}

async function runSearch({ criteria, page, limit, sortProperty, sortDirection }: SearchOpts) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const body = {
    pagination: { page: Math.max(Number(page) || 1, 1), size },
    sort: { property: sortProperty || 'decisionDate', direction: sortDirection || 'DESC' },
    searchCriteria: { containAll: '', containAny: '', containNot: '', ...criteria },
  };
  const data = await apiPost('/search', body);
  const rows = Array.isArray(data.data) ? data.data : [];
  return {
    total: data.pagination?.totalRecords ?? rows.length,
    page: data.pagination?.currentPage ?? body.pagination.page,
    total_pages: data.pagination?.totalPages ?? 1,
    has_more: Boolean(data.pagination?.nextPage),
    trials: rows.map(compactRow),
  };
}

function buildCriteria(args: Record<string, unknown>, unknown: string[]): Json {
  const criteria: Json = {};
  if (args.query) criteria.containAny = String(args.query);
  if (args.exclude) criteria.containNot = String(args.exclude);
  if (args.condition) criteria.medicalCondition = String(args.condition);
  if (args.medicine) criteria.productName = String(args.medicine);
  if (args.sponsor) criteria.sponsor = String(args.sponsor);
  if (args.title) criteria.title = String(args.title);
  if (args.endpoint) criteria.endPoint = String(args.endpoint);
  if (args.ct_number) criteria.number = String(args.ct_number);
  if (args.eudract_number) criteria.eudraCtCode = String(args.eudract_number);

  const statuses = resolveStatuses(args.status, unknown);
  if (statuses.length) criteria.status = statuses;
  const phases = resolvePhases(args.phase, unknown);
  if (phases.length) criteria.trialPhaseCode = phases;
  const countries = resolveList(args.country, COUNTRY_IDS, unknown);
  if (countries.length) criteria.msc = countries;
  const ages = resolveList(args.age_group, AGE_GROUPS, unknown);
  if (ages.length) criteria.ageGroupCode = ages;
  const regions = resolveList(args.region, REGIONS, unknown);
  if (regions.length) criteria.trialRegion = regions;

  if (args.gender) {
    const g = String(args.gender).trim().toLowerCase();
    if (g.startsWith('m')) criteria.gender = [1];
    else if (g.startsWith('f')) criteria.gender = [2];
    else unknown.push(String(args.gender));
  }
  if (typeof args.has_results === 'boolean') criteria.hasStudyResults = args.has_results;
  if (typeof args.rare_disease === 'boolean') criteria.rareDisease = args.rare_disease;
  if (typeof args.orphan_designation === 'boolean') criteria.haveOrphanDesignation = args.orphan_designation;
  if (typeof args.low_intervention === 'boolean') criteria.isLowIntervention = args.low_intervention;
  if (args.start_from) criteria.eeaStartDateFrom = String(args.start_from);
  if (args.start_to) criteria.eeaStartDateTo = String(args.start_to);
  return criteria;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ctis_search_trials',
    description:
      'Search clinical trials authorised in the EU/EEA under Regulation 536/2014, from the EU Clinical Trials Information System (CTIS). Filter by medicine or active substance, medical condition, sponsor, trial status, phase, member state, age group, sex, results availability and start date. Returns trial number, title, status, sponsor, phase, conditions, products, per-country status, enrolment and primary endpoint. Answers questions such as which European trials are recruiting for a drug, who sponsors them and which member states they run in.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text terms matched across the trial record (any of the words)' },
        medicine: { type: 'string', description: 'Medicine, brand or active substance name, e.g. "pembrolizumab"' },
        condition: { type: 'string', description: 'Medical condition studied, e.g. "melanoma"' },
        sponsor: { type: 'string', description: 'Sponsor organisation name, e.g. "Novartis"' },
        title: { type: 'string', description: 'Words that must appear in the trial title' },
        endpoint: { type: 'string', description: 'Words appearing in the trial endpoints' },
        exclude: { type: 'string', description: 'Terms that must NOT appear in the record' },
        status: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Trial status: "Under evaluation", "Authorised, recruitment pending", "Authorised, recruiting", "Ongoing, recruiting", "Ongoing, recruitment ended", "Temporarily halted", "Suspended", "Ended", "Expired", "Revoked", "Not authorised", "Cancelled"',
        },
        phase: {
          type: 'array',
          items: { type: 'string' },
          description: 'Trial phase — "1", "2", "3", "4" (or "phase III"), which expands to the integrated phases too',
        },
        country: {
          type: 'array',
          items: { type: 'string' },
          description: 'EEA member states concerned, by name or ISO code, e.g. ["Germany", "ES"]',
        },
        age_group: {
          type: 'array',
          items: { type: 'string' },
          description: 'Age range of subjects: "in utero", "0-17 years", "18-64 years", "65+ years"',
        },
        region: { type: 'string', description: 'Where the trial runs: "EEA only", "non-EEA only" or "both"' },
        gender: { type: 'string', description: 'Restrict to trials enrolling "male" or "female" subjects' },
        has_results: { type: 'boolean', description: 'Only trials that have posted study results' },
        rare_disease: { type: 'boolean', description: 'Only trials in a rare disease' },
        orphan_designation: { type: 'boolean', description: 'Only trials of a product with an orphan designation' },
        low_intervention: { type: 'boolean', description: 'Only low-intervention trials' },
        start_from: { type: 'string', description: 'Earliest EEA start date, YYYY-MM-DD' },
        start_to: { type: 'string', description: 'Latest EEA start date, YYYY-MM-DD' },
        sort_by: {
          type: 'string',
          description: 'Sort field: decisionDate (default), ctNumber, sponsor, ctStatus',
        },
        sort_direction: { type: 'string', description: 'ASC or DESC (default DESC)' },
        page: { type: 'number', description: 'Result page, 1-based' },
        limit: { type: 'number', description: 'Results per page, 1-100 (default 20)' },
      },
    },
  },
  {
    name: 'ctis_trial',
    description:
      'Full published record for one EU clinical trial by its CTIS number (e.g. 2025-523586-18-00): full scientific title, sponsor and contacts, investigational products with active substances and roles, medical conditions, therapeutic areas, trial objective, eligibility criteria, primary and secondary endpoints, planned enrolment, estimated end date, and the authorisation status, decision date and reported start and recruitment events in each member state. Sourced from the EU Clinical Trials Information System.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ct_number: { type: 'string', description: 'CTIS trial number, e.g. "2025-523586-18-00"' },
      },
      required: ['ct_number'],
    },
  },
  {
    name: 'ctis_trials_for_medicine',
    description:
      'Every EU/EEA clinical trial involving a named medicine or active substance, from the EU Clinical Trials Information System, newest authorisation first. Splits the result by trial status so it is clear how many are still recruiting versus ended, and lists sponsors and member states. Answers "what is running in Europe for this drug".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        medicine: { type: 'string', description: 'Medicine, brand or active substance name, e.g. "semaglutide"' },
        recruiting_only: { type: 'boolean', description: 'Only trials currently authorised or recruiting' },
        country: { type: 'array', items: { type: 'string' }, description: 'Restrict to these member states' },
        limit: { type: 'number', description: 'Trials to return, 1-100 (default 25)' },
      },
      required: ['medicine'],
    },
  },
  {
    name: 'ctis_recent_authorisations',
    description:
      'Clinical trials most recently authorised in the EU/EEA, newest decision first, from the EU Clinical Trials Information System. Optionally narrowed to a member state, a medical condition, a sponsor or a phase. Answers "what did the EU authorise this month" and shows what sponsors are starting in Europe now.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'Only decisions on or after this date, YYYY-MM-DD' },
        country: { type: 'array', items: { type: 'string' }, description: 'Member states concerned' },
        condition: { type: 'string', description: 'Medical condition, e.g. "breast cancer"' },
        sponsor: { type: 'string', description: 'Sponsor organisation name' },
        phase: { type: 'array', items: { type: 'string' }, description: 'Trial phase, e.g. ["3"]' },
        limit: { type: 'number', description: 'Trials to return, 1-100 (default 25)' },
      },
    },
  },
];

function flattenDetail(d: Json): Json {
  const app = d.authorizedApplication ?? {};
  const p1 = app.authorizedPartI ?? {};
  const details = p1.trialDetails ?? {};
  const info = details.trialInformation ?? {};
  const ids = details.clinicalTrialIdentifiers ?? {};
  const category = info.trialCategory ?? {};
  const duration = info.trialDuration ?? {};
  const population = info.populationOfTrialSubjects ?? {};
  const appInfo = Array.isArray(app.applicationInfo) ? app.applicationInfo[0] ?? {} : app.applicationInfo ?? {};

  const sponsors = (p1.sponsors ?? []).map((s: Json) => {
    const org = s.publicContacts?.[0]?.organisation ?? s.scientificContacts?.[0]?.organisation ?? {};
    return {
      name: org.name ?? null,
      type: org.type ?? null,
      commercial: org.commercial ?? null,
      primary: Boolean(s.primary),
    };
  });

  const products = (p1.products ?? []).map((p: Json) => {
    const info2 = p.productDictionaryInfo ?? {};
    return {
      name: info2.prodName ?? info2.sponsorProductCode ?? null,
      active_substance: info2.activeSubstanceName ?? null,
      pharmaceutical_form: info2.pharmForm ?? null,
      eu_product_number: info2.euMpNumber ?? null,
      role: { '1': 'Test', '2': 'Comparator', '3': 'Placebo', '4': 'Auxiliary' }[String(p.part1MpRoleTypeCode)] ?? null,
    };
  });

  const endpoints = info.endPoint ?? {};
  const eventsByCountry = (d.events?.trialEvents ?? []).map((e: Json) => ({
    country: e.mscName,
    events: (e.events ?? []).map((ev: Json) => ({
      event: String(ev.notificationType ?? '').toLowerCase().replace(/_/g, ' '),
      date: isoDate(ev.date),
    })),
  }));

  const phaseCode = Number(category.trialPhase);

  return {
    ct_number: d.ctNumber,
    status: d.ctStatus ?? statusLabel(d.ctPublicStatusCode),
    title: ids.fullTitle ?? null,
    public_title: ids.publicTitle ?? null,
    protocol_code: ids.shortTitle ?? null,
    /** The same trial is usually registered on ClinicalTrials.gov too — this is the join key. */
    nct_number: ids.secondaryIdentifyingNumbers?.nctNumber?.number ?? null,
    who_utn: ids.secondaryIdentifyingNumbers?.whoUniversalTrialNumber?.number ?? null,
    eudract_number: app.eudraCt?.eudraCtCode ?? null,
    phase: PHASE_LABELS[phaseCode] ?? null,
    low_intervention: category.isLowIntervention ?? null,
    decision_date: isoDate(d.decisionDate),
    published_date: isoDate(d.publishDate),
    region: d.trialRegion ?? null,
    sponsors,
    products,
    medical_conditions: (p1.medicalConditions ?? []).map((c: Json) => c.medicalCondition).filter(Boolean),
    therapeutic_areas: (p1.therapeuticAreas ?? []).map((t: Json) => t.name).filter(Boolean),
    objective: info.trialObjective?.mainObjective ?? null,
    secondary_objectives: (info.trialObjective?.secondaryObjectives ?? [])
      .map((o: Json) => o.secondaryObjective ?? o.objective)
      .filter(Boolean),
    subjects_planned: p1.rowSubjectCount ?? null,
    eligibility: {
      inclusion: (info.eligibilityCriteria?.principalInclusionCriteria ?? [])
        .map((c: Json) => c.principalInclusionCriteria)
        .filter(Boolean),
      exclusion: (info.eligibilityCriteria?.principalExclusionCriteria ?? [])
        .map((c: Json) => c.principalExclusionCriteria)
        .filter(Boolean),
    },
    primary_endpoints: (endpoints.primaryEndPoints ?? []).map((e: Json) => e.endPoint).filter(Boolean),
    secondary_endpoints: (endpoints.secondaryEndPoints ?? []).map((e: Json) => e.endPoint).filter(Boolean),
    population: {
      groups: (population.clinicalTrialGroups ?? []).map((g: Json) => g.name).filter(Boolean),
      female_subjects: population.isFemaleSubjects ?? null,
      male_subjects: population.isMaleSubjects ?? null,
      vulnerable_population: population.isVulnerablePopulationSelected ?? null,
    },
    recruitment_start_estimate: isoDate(duration.estimatedRecruitmentStartDate),
    estimated_end_date: isoDate(duration.estimatedGlobalEndDate ?? duration.estimatedEndDate),
    // trialGlobalEnd is an array on trials that have not ended, an object once they have.
    global_end_date: isoDate(
      Array.isArray(app.trialGlobalEnd)
        ? app.trialGlobalEnd[0]?.globalEndDate
        : app.trialGlobalEnd?.globalEndDate,
    ),
    submission_date: isoDate(appInfo.submissionDate),
    assessment_outcome: appInfo.partI?.assessmentOutcome ?? null,
    member_states: (app.memberStatesConcerned ?? []).map((m: Json) => ({
      country: m.mscName,
      status: statusLabel(m.mscPublicStatusCode),
      first_decision_date: isoDate(m.firstDecisionDate),
      last_decision_date: isoDate(m.lastDecisionDate),
    })),
    events_by_country: eventsByCountry.filter((e: Json) => e.events.length),
    has_results: Boolean(d.results && Object.keys(d.results).length),
    documents: (d.documents ?? []).length,
    pubmed_url: details.pubmedUrl ?? null,
    url: `${PORTAL}/${d.ctNumber}`,
    source: SOURCE,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ctis_search_trials': {
      const unknown: string[] = [];
      const criteria = buildCriteria(args, unknown);
      const result = await runSearch({
        criteria,
        page: args.page as number,
        limit: args.limit as number,
        sortProperty: args.sort_by as string,
        sortDirection: (args.sort_direction as 'ASC' | 'DESC') ?? undefined,
      });
      if (!result.trials.length) {
        return {
          found: false,
          reason: 'no_trials_match',
          hint: unknown.length
            ? `These filter values were not recognised and were ignored: ${unknown.join(', ')}. Check the allowed values in the tool schema.`
            : 'CTIS covers trials authorised under Regulation 536/2014 (from 2022 onward). For older European trials try the EU Clinical Trials Register via clinicaltrials, or drop filters and search by medicine name alone.',
          unrecognised_filters: unknown,
          source: SOURCE,
        };
      }
      return { found: true, ...result, unrecognised_filters: unknown, source: SOURCE };
    }

    case 'ctis_trial': {
      const ct = String(args.ct_number ?? '').trim();
      if (!ct) throw new Error('ct_number is required');
      const detail = await apiGet(`/retrieve/${encodeURIComponent(ct)}`);
      // An unknown trial number answers 200 with `{}` — not a 404 — so the
      // absence of ctNumber is the only signal that nothing was found.
      if (!detail || !detail.ctNumber) {
        return {
          found: false,
          reason: 'trial_not_found',
          ct_number: ct,
          hint: 'CTIS numbers look like 2025-523586-18-00 (year-sequence-checksum-application). Use ctis_search_trials to find the number first.',
          source: SOURCE,
        };
      }
      return { found: true, ...flattenDetail(detail) };
    }

    case 'ctis_trials_for_medicine': {
      const medicine = String(args.medicine ?? '').trim();
      if (!medicine) throw new Error('medicine is required');
      const unknown: string[] = [];
      const criteria: Json = { productName: medicine };
      const countries = resolveList(args.country, COUNTRY_IDS, unknown);
      if (countries.length) criteria.msc = countries;
      if (args.recruiting_only) criteria.status = [2, 3, 4];
      const result = await runSearch({ criteria, limit: (args.limit as number) ?? 25 });
      if (!result.trials.length) {
        return {
          found: false,
          reason: 'no_trials_for_medicine',
          medicine,
          hint: 'The register matches the product name as filed by the sponsor — try the active substance (e.g. "semaglutide" rather than "Ozempic"), or search the condition with ctis_search_trials.',
          source: SOURCE,
        };
      }
      const byStatus: Record<string, number> = {};
      for (const t of result.trials) {
        const key = t.status ?? 'unknown';
        byStatus[key] = (byStatus[key] ?? 0) + 1;
      }
      return {
        found: true,
        medicine,
        total: result.total,
        returned: result.trials.length,
        by_status: byStatus,
        trials: result.trials,
        unrecognised_filters: unknown,
        source: SOURCE,
      };
    }

    case 'ctis_recent_authorisations': {
      const unknown: string[] = [];
      const criteria = buildCriteria(
        { condition: args.condition, sponsor: args.sponsor, phase: args.phase, country: args.country },
        unknown,
      );
      const result = await runSearch({
        criteria,
        limit: (args.limit as number) ?? 25,
        sortProperty: 'decisionDate',
        sortDirection: 'DESC',
      });
      const since = typeof args.since === 'string' ? args.since : null;
      const trials = since ? result.trials.filter((t: Json) => (t.decision_date ?? '') >= since) : result.trials;
      if (!trials.length) {
        return {
          found: false,
          reason: since ? 'no_authorisations_in_window' : 'no_trials_match',
          hint: since
            ? `No trial matching these filters was authorised on or after ${since}. The most recent matching decision is ${result.trials[0]?.decision_date ?? 'unknown'} — widen the window or drop the filters.`
            : 'Drop the filters and retry; the unfiltered register returns the most recent authorisations across the EEA.',
          most_recent_decision_date: result.trials[0]?.decision_date ?? null,
          source: SOURCE,
        };
      }
      return {
        found: true,
        since,
        total_matching_filters: result.total,
        returned: trials.length,
        trials,
        unrecognised_filters: unknown,
        source: SOURCE,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
