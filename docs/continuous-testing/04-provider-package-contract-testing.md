# Provider and Package Contract Testing

This document defines the missing fidelity layer between Drive's deterministic
model simulation and sparse calls to real model providers. Its purpose is to
answer a concrete question:

> Given the exact packages selected by OpenCode, what happens for this request,
> response, stream fragment, transport failure, or cancellation?

The answer should come from executing those packages, not from reimplementing
what we think they do in a mock.

## Target Snapshot

This design was checked against the local `../opencode` `v2` ref at
`c53f4cfb094bb87852d0c3c8e83933e902e81283`. The remote-tracking `origin/v2`
was newer at the time of review, so implementation work must refresh the
inventory and record the exact tested commit in every compatibility report.

The relevant V2 ownership is:

- `packages/ai` owns the provider-neutral schema, native protocols, routes,
  transports, provider entrypoints, and typed `AIError` model;
- `packages/core/src/model-resolver.ts` maps catalog package metadata to native
  routes, package-like entrypoints, or the AI SDK fallback;
- `packages/core/src/aisdk.ts` adapts packages using the AI SDK provider
  interface into canonical OpenCode events and errors;
- `packages/core/src/session/runner` owns retry, continuation, compaction, tool,
  and durable session behavior;
- `packages/simulation/src/backend` replaces outbound HTTP in Drive mode and
  exposes controlled inference through the canonical simulation protocol;
- `packages/http-recorder` records and replays real Effect HTTP and WebSocket
  traffic;
- this repository controls the simulated backend and user-facing system through
  Drive.

These boundaries matter more than the raw number of dependencies.

## The Central Rule

**Mock the transport or an explicit service boundary; execute the package.**

Do not create hand-written replacements for every provider SDK, parser, auth
helper, or package export. Such replacements only prove that the replacement
behaves as authored. They cannot reveal whether an installed package:

- throws synchronously while constructing a model;
- rejects when preparing a request;
- returns a non-2xx provider error;
- emits an error event inside an otherwise successful stream;
- returns malformed usage or finish metadata;
- hangs after partial output;
- retries internally;
- reacts differently to cancellation before and after bytes are observed;
- changes its normalization behavior after a dependency upgrade.

Instead, instantiate the actual package selected by the tested OpenCode lockfile
and route its network calls to a programmable local transport. The transport
can emit exact status codes, headers, bodies, SSE frames, WebSocket frames,
read failures, and timing. The package's observed output is the result under
test.

There are narrow exceptions:

- use `TestLLM` when a unit test is explicitly about a consumer of canonical
  `LLMEvent`s and provider lowering is outside its scope;
- provide an Effect test layer for filesystem, clock, process, credential, or
  catalog services when that service is the declared boundary under test;
- stub a package loader to test selection and loading failures without
  installing arbitrary packages;
- use a deliberately fake implementation to test the port's consumer contract,
  while keeping a separate contract suite for every real implementation.

The exception must be visible in the test name and coverage metadata.

## Four Different Things Commonly Called an Inference Mock

These layers solve different problems and must not be treated as substitutes.

| Layer | What is replaced | Real code still executed | Best use | Does not prove |
| --- | --- | --- | --- | --- |
| Canonical event fake | `LLMClient` through `TestLLM` | Session consumer above canonical events | Fast runner and consumer unit tests | Provider request lowering, framing, parsing, HTTP errors |
| Drive protocol simulation | Provider behavior controlled through backend RPC | OpenAI Chat request construction, in-memory HTTP route, SSE bytes, framing, schema decode, protocol state machine, runner, server, TUI | Deterministic end-to-end journeys and lifecycle faults | Other protocols, pre-response HTTP failures, many transport variants, AI SDK fallback parity |
| Programmable transport | Effect HTTP/WebSocket transport | Actual native route or AI SDK package plus its adapters | Provider/package contract probes and negative cases | The remote provider's current production behavior |
| Record/replay or live provider | Nothing below provider API, then replayed transport | Actual request path and real recorded response | Drift detection and realistic golden cases | Unrecorded failures, timing/backpressure when the recorder buffers |

All four belong in the verification portfolio. Calling all of them “the mock”
would hide which behavior a passing test actually covered.

## What Drive V2 Already Exercises

Drive's default isolated project selects:

```json
{
  "model": "simulation/gpt-sim-model",
  "providers": {
    "simulation": {
      "package": "@opencode-ai/ai/providers/openai/chat"
    }
  }
}
```

In V2, `packages/simulation/src/backend/openai.ts` claims the real OpenAI Chat
endpoint. Controlled Drive items are encoded as OpenAI Chat chunks and streamed
as SSE ending in `[DONE]`. Downstream code then performs the normal:

```text
canonical Drive output
        |
        v
OpenAI Chat-shaped SSE bytes
        |
        v
real SSE framing and event Schema
        |
        v
real OpenAI Chat protocol state machine
        |
        v
canonical LLMEvent stream
        |
        v
real Session runner, projections, server, and TUI
```

This is much stronger than returning an assistant string directly to the
session runner. Text chunking, reasoning chunks, tool-input assembly, tool
calls, finish reasons, incomplete streams, interruption, and durable session
effects pass through real production code.

The V2 simulated network also denies any unregistered destination. A deterministic
Drive run cannot silently leak to a real provider.

## What Drive Does Not Cover Today

The current simulated backend registers one main inference route: OpenAI Chat.
Consequently, ordinary Drive journeys do not establish contract compatibility
for all of these paths:

- OpenAI Responses over HTTP;
- Open Responses-compatible deployments;
- OpenAI Responses WebSocket channel execution;
- Anthropic Messages and Anthropic-compatible Messages;
- Gemini Developer API;
- Vertex Gemini, Chat, Responses, and Messages;
- Bedrock Converse and AWS event-stream framing;
- Bedrock Mantle Chat and Responses;
- Azure route selection and endpoint variants;
- OpenRouter and other provider-specific metadata/options;
- native package entrypoint construction and settings validation;
- dynamic AI SDK package loading and the `packages/core/src/aisdk.ts` adapter;
- authentication and endpoint resolution failures before a request is sent;
- non-2xx HTTP failures because the current Drive route normally returns 200;
- connection failure before headers, response-body read failure, truncated
  framing, wrong content type, and backpressure;
- retry classification across all canonical error reasons;
- real-provider drift.

This is the package-contract backlog. It is finite and can be generated from
routes, protocols, package mappings, and error categories; it is not an
unbounded requirement to mimic every dependency.

## V2 Runtime Paths to Inventory

The inventory must be generated from the tested ref on every compatibility
campaign. At the reviewed snapshot there are three principal resolution paths.

### Direct native routes

`ModelResolver` directly maps some catalog `aisdk:` metadata to native routes:

- `@ai-sdk/openai` to OpenAI Responses;
- `@ai-sdk/anthropic` to Anthropic Messages;
- `@ai-sdk/openai-compatible` with an explicit URL to OpenAI-compatible Chat.

These paths execute `@opencode-ai/ai` protocols and do not instantiate the
external provider package.

### Native package-like entrypoints

`AISDKNative.map` translates selected AI SDK package identities and settings to
export paths inside the single `@opencode-ai/ai` package. Examples include
Google, Azure, Bedrock, Bedrock Mantle, OpenRouter, xAI, and Vertex Messages.

These are API slices, not separately published packages. Contract tests should
still test each exported `model(modelID, settings)` entrypoint because route,
auth, endpoint, defaults, and settings mapping differ.

### Dynamic AI SDK fallback

When no native mapping exists, production may load an external AI SDK provider
package and adapt its `LanguageModelV3` stream through
`packages/core/src/aisdk.ts`.

This path requires two contracts:

1. package loading and model construction from catalog settings;
2. conversion of AI SDK stream parts and `APICallError` values into canonical
   `LLMEvent` and `AIError` values.

The contract report must say which runtime path was exercised. Reporting only
the catalog provider and model would hide a native/fallback switch.

## Provider Contract Harness

The provider contract harness belongs primarily in `../opencode`, close to
`packages/ai` and `packages/core`. Drive consumes its summarized results in the
continuous-verification control plane; `packages/drive` must not absorb
OpenCode-specific provider inventories.

Conceptual structure:

```text
ProviderCase
  route or package identity
  model/settings/credential fixture
  canonical LLMRequest
  TransportScript
  expected BehaviorFingerprint
             |
             v
real model construction / ModelResolver
             |
             v
real protocol or actual AI SDK package
             |
             v
programmable HttpClient / WebSocketConstructor
             |
             v
observed events, failure, timing, attempts, requests
             |
             v
canonical fingerprint + assertions
```

The first implementation should extend the existing test support rather than
introduce another framework. `packages/ai/test/lib/http.ts`, SSE helpers,
protocol-specific fixtures, `@opencode-ai/ai/testing`, and the Effect service
boundaries are already useful building blocks.

## Programmable Transport

A transport script is an ordered description of what the provider-facing code
will observe. It is lower-level than `Llm.Output` because its purpose is to
exercise framing, schemas, package behavior, and transport errors.

Illustrative schema:

```text
TransportScript
  protocol
  expected request matcher
  attempts[]

TransportAttempt
  optional delay before headers
  outcome:
    HttpResponse
      status
      headers
      body chunks[]
      optional body failure after chunk N
    RequestFailure
      code
      message
      delivery phase
    Hang
      phase
    WebSocketExchange
      handshake outcome
      expected client frames[]
      server frames[]
      close or failure
```

The implementation should provide an Effect `HttpClient.HttpClient` layer and,
where applicable, a scoped `Socket.WebSocketConstructor` layer. It should not
patch global `fetch` unless a specific external package offers no injectable
transport and that limitation is recorded.

The harness records every attempted request before responding. It validates:

- method, normalized URL, query, and selected safe headers;
- body against the provider-native schema or a stable semantic projection;
- attempt count and ordering;
- whether cancellation interrupted the response producer;
- whether every scripted response was consumed;
- whether an unexpected destination was attempted.

An unexpected request fails loudly. Real network egress is denied in contract
tests.

## Behavior Fingerprints

We do not need to guess whether a package “throws.” We run a probe and capture
the complete observable shape.

Each case produces a canonical behavior fingerprint:

```text
BehaviorFingerprint
  schemaVersion
  targetRevision
  lockfileDigest
  packageIdentity
  packageVersion
  runtimePath: native-route | native-entrypoint | aisdk-fallback
  protocol
  requestDigest
  transportScriptDigest
  requests[]
  events[]
  terminal:
    completed
    failed
    defected
    interrupted
    timed-out
  failure?:
    stage
    class/tag
    canonical reason
    safe message pattern
    status/code
    retry metadata
    cause summary
  outputStarted
  requestAttempts
  retryDecision
  sessionProjection?: safe summary
```

The event projection should retain event types, stable IDs normalized to
placeholders, finish reasons, usage presence, and provider-metadata keys. Large
text and opaque provider values are replaced with digests or safe summaries.

Fingerprints serve three purposes:

- assertions for behavior that is intentionally stable;
- reviewable diffs after package upgrades;
- input to differential tests between native and fallback implementations.

A changed fingerprint is not automatically a regression. It is an explicit
compatibility review instead of an invisible behavior change.

## Outcome Taxonomy

Every probe must terminalize into exactly one harness outcome:

| Outcome | Meaning |
| --- | --- |
| `completed` | A canonical terminal finish was consumed successfully |
| `failed` | The typed error channel produced an expected domain failure |
| `defected` | Code died, threw outside the declared error channel, or violated an invariant |
| `interrupted` | The test deliberately cancelled and all scoped resources closed |
| `timed-out` | The case did not terminalize inside its declared bound |
| `harness-failed` | Request matching, script consumption, or evidence capture was invalid |

Never coerce defects, timeouts, or interruptions into a generic provider error.
Their difference is exactly what these tests need to reveal.

## Canonical V2 Error Contract

At the reviewed V2 snapshot, `@opencode-ai/ai` exposes these canonical reason
tags:

- `InvalidRequest`, optionally classified as `context-overflow` or
  `payload-too-large`;
- `NoRoute`;
- `Authentication`;
- `RateLimit`;
- `QuotaExceeded`;
- `ContentPolicy`;
- `ProviderInternal`;
- `Transport`;
- `InvalidProviderOutput`, optionally classified as `incomplete-stream`;
- `UnknownProvider`.

`packages/core/src/session/to-session-error.ts` projects them to stable
session-facing types such as `provider.rate-limit`, `provider.auth`,
`provider.transport`, and `provider.invalid-output`.

The runner's generic retry policy is also observable contract:

- retry `RateLimit` and `ProviderInternal`;
- retry `Transport` only when delivery is absent or `not-sent`;
- retry an `InvalidProviderOutput` only for `incomplete-stream`;
- do not retry authentication, quota, policy, invalid request, no-route, or
  unknown-provider failures;
- do not retry after visible output in the ordinary pre-output retry path;
- allow separate incomplete-stream continuation and context-overflow recovery
  rules where the runner declares them.

Provider/package probes assert the `AIError`. A smaller integration layer then
asserts the session projection, durable events, retry scheduling, and UI
recovery. Keeping these two assertions separate identifies whether a failure is
in parsing/classification or in session policy.

## Failure Corpus

The corpus should be systematic. Every applicable protocol/package receives
the shared core cases plus protocol-specific cases.

### HTTP response cases

- 200 with the smallest valid stream;
- 200 with an empty body;
- 200 with the wrong content type;
- 200 with whitespace or keepalive-only content;
- 204 and 304 responses;
- 400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504, and 529;
- a known structured provider error body;
- a plain-text error body;
- malformed JSON error body;
- empty structured message and code-only body;
- large body and truncation boundary;
- `Retry-After`, `retry-after-ms`, and provider rate-limit headers;
- request ID headers;
- a provider error disguised behind an unexpected status.

The expectation is not that every status maps identically for every provider.
The expectation is that behavior is explicit and reviewed.

### Transport cases

- DNS/connect failure before request delivery;
- TLS or handshake failure;
- abort before headers;
- response-body read reset before any frame;
- response-body read reset after valid partial output;
- hang before headers;
- hang between frames;
- cancellation while waiting, reading, or decoding;
- middleware failure before and after request mutation;
- unexpected redirect or endpoint;
- connection close with delivery known, unknown, or accepted.

### Framing and decoding cases

- one event per chunk and many events per chunk;
- one event split across arbitrary byte chunks;
- UTF-8 code point split across chunks;
- comments, keepalives, blank lines, and provider-specific preambles;
- malformed JSON frame;
- valid JSON with missing required fields;
- unknown forward-compatible event;
- duplicate start, finish, or terminal event;
- data after terminal;
- clean EOF without a protocol terminal;
- provider error event within a 200 stream;
- inconsistent IDs or indices;
- negative, missing, fractional, or contradictory usage fields.

### Tool cases

- complete tool call in one event;
- arguments split at every byte boundary;
- empty arguments where the protocol treats them as `{}`;
- invalid JSON arguments;
- unknown tool name;
- duplicate tool-call ID;
- parallel calls with interleaved fragments;
- hosted/provider-executed call and result;
- hosted call with missing result;
- local tool call followed by an ordinary finish;
- finish reason inconsistent with emitted calls;
- interruption before arguments parse and during tool execution.

### Request-lowering cases

- empty and minimal messages;
- chronological system updates;
- text, image, PDF, and provider-supported media;
- cache hints and cache usage;
- portable generation options at limits;
- provider-specific options;
- raw HTTP overlays;
- tool-choice variants;
- malformed history that compatibility patches may accept;
- large context and payload boundaries;
- unknown provider-defined strings that should remain forward-compatible.

### Model construction and package cases

- missing, invalid, and empty credentials;
- endpoint derived from required variables;
- unresolved `${VARIABLE}` placeholders;
- base URL normalization and provider path selection;
- unknown package export;
- package module without the `model` contract;
- `model(...)` throwing synchronously;
- settings mapping with unsupported types;
- catalog variant overlay ordering;
- native mapping selected when expected;
- fallback selected when no mapping exists;
- a native/fallback selection change captured as a fingerprint diff.

## Discovering Unknown Errors

The corpus above captures known categories. Property and mutation probes find
cases we did not anticipate.

The discovery loop is:

1. Construct a valid provider-native request and valid response transcript.
2. Confirm it completes through the actual package.
3. Apply one controlled mutation.
4. Run with a strict deadline and real cancellation.
5. Capture the resulting fingerprint, including defects and hangs.
6. Shrink the mutation to the smallest reproducing transcript.
7. Classify it as acceptable, a product defect, an upstream package defect, or
   an unsupported input.
8. Promote the minimized case into the permanent regression corpus.

Useful mutations include:

- delete one required field;
- replace a value with every JSON primitive type;
- duplicate, reorder, or omit an event;
- split bytes at a generated boundary;
- truncate at every frame boundary;
- replace a known enum with an unknown string;
- change one ID between start/delta/end;
- inject one provider error before or after output;
- cancel at every lifecycle checkpoint;
- vary status, code, message, and retry headers independently.

Property generation should produce valid cases more often than invalid noise.
A protocol-specific generator knows the state machine and can deliberately
violate one rule at a time. Pure arbitrary JSON fuzzing is supplementary.

## Shrinking

A useful failure is a small failure. The shrinker should minimize in this
order:

1. remove whole transport attempts;
2. remove frames not needed to reproduce;
3. remove unrelated fields;
4. shorten strings and arrays;
5. reduce chunk count and delay;
6. reduce the request history;
7. normalize generated IDs.

The stored replay artifact contains the minimized case and the original seed.
Shrinking runs in an ephemeral process so a stuck or defective candidate does
not poison a persistent lane.

## Native-versus-Fallback Differential Testing

During the V2 migration, some provider identities can execute through native
`@opencode-ai/ai` code while others still use an AI SDK package. Differential
testing is the fastest way to find semantic gaps.

For one canonical request and semantically equivalent wire transcripts:

```text
                  canonical request
                     /       \
                    v         v
           native protocol   AI SDK package + adapter
                    \         /
                     v       v
              normalized fingerprints
                         |
                         v
                semantic comparison
```

Compare stable semantics, not implementation accidents:

- request roles/content/tool schemas;
- event ordering and tool-call assembly;
- normalized finish reason;
- usage and cache usage;
- provider-executed tool markers;
- canonical error reason and retry metadata;
- cancellation and partial-output behavior.

Allow explicit differences for provider-native metadata and features. Every
allowance has an owner, rationale, and expiry/review condition. A broad
“snapshots differ” waiver is not sufficient.

Differential tests are particularly valuable before changing `ModelResolver`
or `AISDKNative.map`, because the same catalog model may silently move from one
runtime implementation to another.

## Record/Replay and Live Provider Probes

The target already includes `@opencode-ai/http-recorder` and many committed
provider recordings. Reuse them for high-realism success and tool-loop cases.

Recordings provide:

- real request shapes;
- real headers after redaction;
- real provider event variants;
- realistic optional fields and metadata;
- deterministic replay without cost or provider availability.

They do not replace programmable negative cases. The recorder currently
buffers HTTP responses, so it cannot faithfully test streaming timing,
cancellation, or backpressure. WebSocket replay preserves frame chronology but
not transport timing and does not capture every handshake/failure dimension.

A small live lane refreshes confidence that recordings still resemble current
providers:

- allowlisted provider/model only;
- minimal prompts and token limits;
- strict daily budget;
- no arbitrary tool execution;
- credentials isolated from Drive artifacts;
- response/request IDs in restricted evidence;
- new recordings reviewed and redacted before commit;
- live failure does not automatically imply an OpenCode product regression.

Live calls should refresh selected cassettes and emit drift reports. They should
not run every generated malformed-input case against a real provider.

## Package Upgrade Gate

Every change to the lockfile or provider mapping computes the impacted set:

```text
changed package/version
        |
        +--> provider entrypoints importing it
        +--> protocols/transports importing it
        +--> ModelResolver mappings selecting it
        +--> existing contract cases tagged for those paths
```

The gate runs:

1. compile/type contract tests;
2. model construction and request-lowering tests;
3. shared error/fault corpus;
4. protocol-specific valid and malformed streams;
5. recorded provider cases;
6. native/fallback differential cases where applicable;
7. a small Drive end-to-end smoke if the canonical OpenAI Chat simulation path
   or session projection changed.

The report includes added, removed, and changed fingerprints. Reviewers approve
intentional changes in the same pull request.

## Continuous Cadence

Package contracts do not need a persistent TUI lane. They are mostly ephemeral,
parallel, and cheap. Their role in the 24/7 system is:

| Cadence | Campaign |
| --- | --- |
| Every pull request | Impacted deterministic package contracts and core Drive smoke |
| On merge to `v2` | Full deterministic native protocol and resolver matrix |
| Hourly | Small rotating malformed/fault corpus against the deployed revision |
| Nightly | Broader property/mutation campaign with shrinking |
| Daily or budgeted | Selected live-provider drift probes |
| On dependency update | Full affected-package fingerprints and differential parity |
| Weekly | Refresh coverage inventory and find untested routes/mappings |

The control plane treats these as a separate `provider-contract` lane kind.
They publish into the same run/evidence store but do not pretend to be user
journeys.

## One Logical Bot Per Provider Contract

Use one logical bot profile per independently meaningful provider contract.
This is close to “one bot per AI package/provider,” but the split follows the
runtime behavior under test rather than marketing brand alone.

Split a bot when any of these differ:

- package or package-like export path;
- native versus AI SDK fallback implementation;
- semantic protocol, such as Chat, Responses, Messages, Gemini, or Converse;
- transport, such as HTTP, WebSocket channel, or AWS event stream;
- auth/endpoint construction substantial enough to have an independent
  contract;
- credential/network profile for live probes;
- owner or release decision.

Illustrative V2 bot inventory:

```text
provider.openai.chat.native
provider.openai.responses-http.native
provider.openai.responses-websocket.native
provider.openai-compatible.chat.native
provider.open-responses.native
provider.anthropic.messages.native
provider.anthropic-compatible.messages.native
provider.google.gemini.native
provider.google-vertex.gemini.native
provider.google-vertex.chat.native
provider.google-vertex.responses.native
provider.google-vertex.messages.native
provider.amazon-bedrock.converse.native
provider.amazon-bedrock.mantle-chat.native
provider.amazon-bedrock.mantle-responses.native
provider.azure.chat.native
provider.azure.responses.native
provider.openrouter.chat.native
provider.xai.<selected-api>.native
provider.<catalog-package>.aisdk-fallback
provider.resolver.matrix
provider.error-projection.session
```

Generate the concrete list from the pinned target ref; this illustration is not
a hard-coded registry.

Each provider bot runs:

1. entrypoint/model construction;
2. request-lowering assertions;
3. smallest valid text stream;
4. tool-call and continuation cases when supported;
5. the applicable shared HTTP/transport error corpus;
6. protocol-specific malformed streams;
7. cancellation at declared phases;
8. recorded cases;
9. optional live drift sub-profile;
10. fingerprint comparison with its last reviewed baseline.

Shared protocol code should not cause uncontrolled duplication. Use a layered
matrix:

- the protocol bot runs the full framing/malformed-event corpus;
- every provider bot runs construction, endpoint/auth/options, a valid stream,
  representative error, and its recordings;
- a resolver bot verifies catalog identity selects the intended runtime path;
- a session projection bot runs each canonical `AIError`/retry class through
  the runner;
- provider-specific cases extend, rather than copy, the common corpus.

These are logical scheduler identities. A bounded ephemeral worker pool can run
them in parallel and isolate each case in its own Effect scope/process. Give a
bot a dedicated long-running worker only for unique native dependencies,
credentials, network policy, or provider rate limits.

Provider bot health includes:

- last scheduled, started, completed, and successful attempt;
- pinned OpenCode commit and package version;
- deterministic contract outcome;
- current fingerprint review state;
- recording age;
- optional live-probe age and budget state;
- known gap/quarantine reason;
- worker/infrastructure blocking reason.

One broken shared worker must make affected bots `stale` or `blocked`; it must
not leave their previous green state looking current.

## Coverage Manifest

The inventory and coverage report should be machine-readable. Suggested rows:

```text
ProviderContractTarget
  id
  packageIdentity
  resolvedPackageVersion
  runtimePath
  providerEntrypoint
  protocol
  transport: http | websocket | eventstream
  modelResolverCases[]
  validCases[]
  errorCases[]
  propertyCampaigns[]
  recordings[]
  liveProbe?: policy
  owners[]
  knownGaps[]
```

Generate the initial manifest from source exports, resolver mappings, and test
metadata; then require human ownership and gap rationale. The report should
flag:

- a runtime path with no valid completion case;
- a protocol with no malformed-stream case;
- an entrypoint with no construction case;
- a retryable error with no session-runner integration case;
- a package version that changed without a fresh report;
- a mapping that changed from fallback to native without differential review;
- a committed recording no longer referenced by a test;
- a live-supported provider whose latest successful probe is too old.

## Evidence and Redaction

Contract evidence often contains provider-native requests, which are more
sensitive than ordinary pass/fail metrics.

Persist by default:

- digests and safe structural projections;
- package identity and version;
- status, safe header names, error tags, and finish reason;
- event type/order with normalized IDs;
- request count, timing, and cancellation points;
- minimized malformed payload when it contains generated fixture data only.

Restrict or redact:

- authorization and API key headers;
- provider query credentials;
- user prompt and model output content;
- tool arguments/results;
- complete provider error bodies that may echo request content;
- cloud account, project, region, deployment, and request identifiers where
  policy requires it.

The target executor intentionally retains detailed HTTP context in typed errors
for diagnosis. Artifact publication must therefore redact again at the
evidence boundary; typed errors are not automatically safe to publish.

## Ownership

Keep ownership aligned with the repositories:

- native route, protocol, error-classification, resolver, AI SDK adapter, and
  recorder tests live in `../opencode`;
- generic simulation-controller laws live in `packages/drive` here;
- OpenCode-specific coverage manifests, campaign policy, dashboards, and
  review UI live in `apps/catalog` here;
- scripts may orchestrate both repositories and pin their exact revisions;
- no provider/package taxonomy is imported from `apps/catalog` into
  `packages/drive`;
- no backend package-control convenience commands are added to the frontend
  simulation CLI.

## Initial Implementation Sequence

### Phase 1: inventory and fingerprint

1. Pin `../opencode:v2` by commit in a campaign manifest.
2. Generate native protocols, provider package entrypoints, resolver mappings,
   fallback identities, and installed versions.
3. Define the fingerprint schema and safe normalization rules.
4. Wrap the existing `packages/ai` valid tests to emit fingerprints.
5. Publish a coverage report without adding new faults yet.

### Phase 2: shared HTTP error corpus

1. Extract a reusable programmable Effect HTTP transport from existing test
   helpers where that reduces duplication.
2. Run the shared status/body/header matrix through native request execution.
3. Assert canonical `AIError` reasons and retry metadata.
4. Add runner integration cases for each retry class and partial-output state.
5. Add strict per-case timeouts and script-consumption checks.

### Phase 3: protocol mutation

1. Add state-aware transcript generators for OpenAI Chat, Responses,
   Anthropic, Gemini, and Bedrock.
2. Mutate one protocol rule per case.
3. Capture and shrink defects, hangs, and unexpected error categories.
4. Promote minimized discoveries into permanent fixtures.
5. Feed results into the continuous control plane.

### Phase 4: resolver and package parity

1. Test every package-like entrypoint's construction/settings contract.
2. Test dynamic loader and AI SDK adapter outcomes.
3. Add native-versus-fallback comparisons for migration candidates.
4. Gate resolver mapping changes on reviewed differential reports.

### Phase 5: recorded and live drift

1. Index existing cassettes in the coverage manifest.
2. Fill high-risk recording gaps identified by V2 `STATUS.md`.
3. Add low-cost allowlisted live probes.
4. Automate age, drift, redaction, and budget alerts.

## Acceptance Criteria

This layer is ready when:

- every runtime provider path says whether it is native, package-like, or AI
  SDK fallback;
- tests execute actual installed package code instead of hand-written package
  replicas;
- every supported protocol has a valid stream, malformed stream, transport
  failure, HTTP failure, cancellation, and tool-call case;
- every canonical `AIError` reason has an intentional session projection and
  retry expectation;
- synchronous throws, typed failures, defects, hangs, and interruptions remain
  distinguishable in reports;
- generated failures shrink to replayable fixtures;
- package upgrades produce reviewable behavior-fingerprint diffs;
- resolver changes cannot silently switch runtime implementation;
- deterministic tests deny accidental real network access;
- recorded/live tests have budget, redaction, and ownership controls;
- Drive end-to-end coverage and provider/package contract coverage are reported
  separately, then correlated in one dashboard.
- every independently meaningful provider/package/protocol path has a logical
  bot with its own cadence, freshness, owner, and visible health;
- provider bots share ephemeral workers by default without sharing mutable case
  state or credentials.
