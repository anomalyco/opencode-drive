# Inference Simulation

This document defines how continuous verification controls model behavior. It
covers deterministic queued responses, request-aware served responses,
fault-injected output, and a later real-provider bridge.

Model control belongs in Effect programs and scripts. It does not become a
Drive CLI command, an alias in the frontend protocol, or an OpenCode media
directory concern.

## Goals

Inference simulation must:

- make important OpenCode behavior reproducible without a provider account;
- exercise text, reasoning, tool input, finish, disconnect, and timing paths;
- support simple authored journeys and stateful generated campaigns;
- detect unexpected or unused requests;
- preserve protocol compatibility and provider-neutral behavior;
- record exactly which response plan influenced an attempt;
- allow controlled nondeterminism only when the seed or distribution is known;
- provide a later path to real provider integration without changing scenario
  and evidence contracts.

## Existing Primitives

[`packages/drive/src/llm/index.ts`](../../packages/drive/src/llm/index.ts)
defines schema-validated output values:

- `Llm.text(text, options)`;
- `Llm.reasoning(text, options)`;
- `Llm.pause(milliseconds)`;
- `Llm.toolCall(call, options)`;
- `Llm.raw(chunk)`;
- `Llm.finish(reason)`;
- `Llm.disconnect()`.

Text, reasoning, and tool-input output can be chunked and paced. The responder
plays those values onto the canonical backend simulation RPCs and guarantees a
terminal event when the authored stream omits one.

The controller exposes:

- `llm.queue(...)`: enqueue output for the next normal request and return;
- `llm.send(...)`: enqueue output and wait until the matched request completes;
- `llm.serve(handler)`: choose a response stream from each opened request;
- `llm.title(handler)`: control title requests separately.

At settlement, queued mode detects unexpected model requests and unused
responses. Output after a terminal event is a controller failure. These
properties make the simulator useful as an oracle, not merely a stub.

## Response Modes

### Queued mode

Queued mode is the default for deterministic, sequential journeys.

Example:

```ts
yield* driver.llm.queue(
  Llm.reasoning("I will inspect the fixture."),
  Llm.text("The fixture value is 42."),
)
yield* driver.ui.submit("Inspect the fixture")
yield* driver.ui.waitFor("The fixture value is 42.")
```

Strengths:

- minimal authoring overhead;
- exact response sequence;
- settlement detects missing or extra exchanges;
- easy to understand in a failed journey;
- ideal for one active attempt per lane.

Constraints:

- responses match normal requests by order;
- unrelated concurrent clients can consume each other's plans;
- complex subagent or request-dependent behavior becomes awkward;
- the lane cannot switch to served mode after queueing begins.

Use a dedicated queued lane and keep attempt concurrency at one.

### `send` mode

`send` is queued mode with a completion barrier. The call returns only after a
request consumed the output and the response finished.

Use it when the script needs to synchronize with model completion directly.
Avoid it when UI observations are the intended assertion; waiting on UI state
usually gives stronger end-to-end evidence.

An interrupted `send` withdraws an unmatched queued response. Once matched,
normal response lifecycle rules apply.

### Served mode

Served mode installs one request-aware handler:

```ts
yield* driver.llm.serve((request, index) =>
  Stream.make(
    Llm.text(`response ${index} for ${request.id}`),
  ),
)
```

The handler receives the opened exchange and a normal-request index. It can
inspect the body, offered tools, session-related metadata exposed by the
protocol, and local campaign state.

Strengths:

- reacts to actual requests;
- supports subagent exchanges and variable request counts;
- supports a generated model of inference behavior;
- can delegate to a real provider bridge later.

Constraints:

- mutable handler state must be scoped and concurrency-safe;
- response routing must not rely on fragile full-body string matching;
- failures in the handler fail the controller;
- one served handler owns all normal exchanges in that controller generation;
- title exchanges need their own handler or documented default.

Use a dedicated reactive lane. Start with one active attempt to keep handler
state and session ownership unambiguous.

## Title Requests

OpenCode may open a separate inference request to generate a conversation
title. Drive recognizes title requests and handles them outside normal request
sequencing, after in-flight normal jobs on which they depend.

Every strategy must decide how titles behave:

- use the default deterministic Drive title;
- configure `llm.title` once for the lane;
- route provider-backed title generation explicitly;
- disable title-sensitive assertions if the strategy intentionally varies
  title text.

Title requests must not consume a normal queued journey response. A response
plan and failure bundle should record whether a request was classified as a
title.

## Strategy Model

The continuous system introduces an app-owned **inference strategy** around the
existing controller. It is configuration and evidence vocabulary, not a new
wire protocol.

Recommended strategy variants:

```text
QueuedPlan
  ordered response plans authored by a scenario

ReactivePlan
  request-aware deterministic handler

GeneratedPlan
  seeded handler selecting valid outputs from a model

FaultPlan
  wraps another plan with deliberate delays/disconnects/errors

ProviderPlan
  calls a real provider and translates its stream into Llm.Output
```

Each attempt records:

- strategy variant and version;
- deterministic plan digest;
- seed when generation or jitter is involved;
- output and fault budgets;
- selected provider/model for real inference;
- request and response summary without secrets;
- compatibility mode used for tool-input streaming.

## Deterministic Response Plans

A response plan is a persisted, schema-validated description of intended
output. It should use the existing `Llm.Output` schema rather than defining a
parallel output vocabulary.

Illustrative proposed model:

```ts
import { Schema } from "effect"
import * as Llm from "opencode-drive/llm"

export class PlannedExchange extends Schema.Class<PlannedExchange>(
  "PlannedExchange",
)({
  label: Schema.String,
  expectedPromptMarker: Schema.optionalKey(Schema.String),
  output: Schema.Array(Llm.Output),
}) {}

export class QueuedResponsePlan extends Schema.Class<QueuedResponsePlan>(
  "QueuedResponsePlan",
)({
  version: Schema.String,
  exchanges: Schema.Array(PlannedExchange),
}) {}
```

The scenario may keep constructing output in code initially. The persisted
representation becomes useful when replaying a failure independently of a
changed source tree. It is not necessary to serialize functions or handler
closures.

Plan validation should reject:

- output after `finish` or `disconnect`;
- negative delays or invalid chunk sizes, already rejected by output schemas;
- duplicate tool-call indices or IDs where the scenario requires uniqueness;
- a tool call for a tool the request cannot offer;
- an empty plan when the scenario requires a normal exchange;
- unbounded pauses in a monitored journey.

## Determinism

Determinism has several layers:

### Semantic determinism

The same request receives the same logical text, tool calls, terminal reason,
and injected failures.

### Timing determinism

Chunk boundaries and delays follow the same sequence.

### Scheduling determinism

Concurrent fibers and external processes interleave identically.

Full scheduling determinism is not realistic for a black-box multi-process
system. The goal is to capture enough inputs to reproduce the behavior at a
high rate and to separate deliberate timing variation from accidental hidden
randomness.

The current text chunk helper varies chunk sizes with `Math.random`. That is
useful for naturally exercising boundaries, but it is not controlled by
Effect's `Random.withSeed`. Before calling a campaign fully replayable, either:

- add an explicit deterministic chunk plan to the app-level response plan;
- provide a seeded randomness seam in the generic simulator if several callers
  need it; or
- record the actual emitted chunk sequence in failure evidence and replay that
  sequence through raw or fixed chunks.

Do not claim seed-only reproduction while an unrecorded random source still
influences timing.

## Request-Aware Routing

A reactive handler should classify requests through structured data where
available.

Recommended routing inputs:

- title versus normal request classification;
- attempt ID known by the lane's active-attempt context;
- request ID;
- request index;
- offered tool names and schemas;
- normalized latest user prompt marker;
- parent/subagent relationship where observable;
- current campaign/model state.

Avoid routing by `JSON.stringify(body).includes(...)` as a permanent design.
It is acceptable in a narrow existing fixture but fragile for an always-on
system. Decode the subset of request body required by the strategy and use
typed predicates.

If the backend protocol does not expose a necessary stable identifier, first
decide whether that identifier belongs in the canonical OpenCode simulation
protocol. Do not invent a Drive-only wire field.

## Tool Calls

Tool-call simulation must preserve provider-neutral semantics.

A plan declares:

- call index;
- stable call ID within the exchange;
- offered tool name;
- JSON input;
- optional chunking/pacing;
- finish reason, normally `tool-calls` when applicable.

The responder uses provider-neutral tool-input start/delta messages when the
endpoint advertises the capability. It falls back to the supported legacy raw
provider chunk when required by compatibility policy.

Scenario assertions should inspect observable tool and server state, not only
the rendered label. Useful assertions include:

- OpenCode offered the intended tool;
- streamed input became valid at the expected boundary;
- permission appeared before execution;
- exactly one invocation exists for the call ID;
- progress and terminal output have valid ordering;
- interruption settles the tool projection correctly;
- a recovery prompt can execute after failure.

## Fault Injection

The output vocabulary already provides several high-value faults:

- `pause` introduces deterministic provider latency;
- `disconnect` terminates the simulated provider exchange;
- streamed tool input allows interruption before JSON is complete;
- output after a terminal event intentionally triggers controller validation;
- a handler can fail with a typed controller error;
- controlled tools can delay, fail, or wait for interruption.

A `FaultPlan` wraps a normal strategy and records:

- injection point;
- fault kind;
- delay or payload;
- expected OpenCode behavior;
- maximum recovery deadline;
- cleanup and cooldown requirements.

Fault injection is never inferred from an ordinary error. If a disconnect was
not declared by the plan, it is an unexpected provider or transport failure.

## Stateful Generated Inference

A generated inference model chooses outputs based on current test state. For
example:

```text
Idle request
  -> stream text
  -> stream reasoning then text
  -> start tool input
  -> disconnect

Tool result request
  -> finish with summary text
  -> request another tool within budget
  -> pause then finish
```

Generation rules must enforce:

- only offered tools are called;
- tool indices and IDs are unique where required;
- terminal events end the output stream;
- step and output budgets prevent infinite tool loops;
- a command records its generation choice before executing it;
- every choice derives from a controlled random service or is captured as an
  explicit trace item.

The property model, not the inference handler alone, decides which transitions
are valid. See [Stateful property testing](./06-stateful-property-testing.md).

## Real Provider Bridge

Real inference is a later strategy implemented at the app/script boundary.
Its purpose is to introduce variable model behavior into a Drive-controlled
journey. It is not the provider-package compatibility harness.

Conceptual flow:

```text
OpenCode opened exchange
          |
          v
ProviderPlan decodes request subset
          |
          v
provider SDK / HTTP streaming call
          |
          v
translate provider events to Llm.Output
          |
          v
existing Drive responder and canonical simulation RPC
```

The bridge should close over a provider client constructed by a scoped Effect
layer. It must not instantiate SDK clients inside every handler call without a
lifecycle policy.

Requirements:

- credentials supplied through a secret provider, never attempt config;
- strict model allowlist;
- per-attempt token and time budget;
- daily lane cost budget and kill switch;
- retry only before the provider has emitted externally visible partial
  output, unless the provider API offers a safe idempotency contract;
- provider request IDs captured in restricted logs, not metrics;
- content redaction before artifact publication;
- provider/model/version recorded in the attempt;
- deterministic mock lane remains the primary product oracle.

Provider failover may later use an Effect `ExecutionPlan` when the purpose is
explicitly to test fallback behavior. Do not hide provider failure with
automatic fallback in a lane intended to monitor one provider.

The bridge projects a real provider's output back through Drive's simulated
OpenAI Chat route. That still exercises the real OpenAI Chat decoding and the
full OpenCode session/UI stack, but it does not prove that OpenCode's selected
Anthropic, Gemini, Bedrock, Azure, Responses, WebSocket, or AI SDK package path
works. It also normalizes away some provider-native failures and metadata.

Test those paths by executing the real installed package against a programmable
HTTP/WebSocket boundary as specified in [Provider and package contract
testing](./04-provider-package-contract-testing.md). Use a sparse production
provider canary only after deterministic contract coverage exists.

## Assertions for Variable Output

Exact strings remain appropriate for deterministic plans. Real or generated
output needs different oracles.

Prefer externally observable properties:

- a response reaches a terminal state;
- the session projection retains the user prompt and assistant parts;
- requested tool input validates against the offered schema;
- a declared file change occurred and has expected structural content;
- permission and form lifecycles settle;
- the composer returns to an actionable state;
- no internal transport defect is shown to the user;
- resource and latency budgets are respected.

An LLM judge can provide supplemental diagnostics, but it must not be the only
oracle for critical correctness. A model judging another variable model creates
correlated failure and makes replay harder.

## Response Evidence

For each exchange, retain a redacted summary:

- attempt and lane generation IDs;
- request ID and ordinal;
- title/normal classification;
- selected strategy and plan step;
- offered tool names;
- output item types and sizes;
- actual chunk count and timing summary;
- finish or disconnect terminal event;
- controller error, if any;
- start, first-output, and terminal timestamps.

Full prompt and response content has stricter retention and redaction policy.
Metrics use low-cardinality types and durations, never raw prompt text or
request IDs.

## Failure Classification

Examples:

| Observation | Likely classification |
| --- | --- |
| Scenario left an authored queued response unused | Harness failure |
| OpenCode made an unexpected extra normal request | Product or protocol drift; investigate before final classification |
| Handler called a tool not offered by OpenCode | Harness failure |
| OpenCode lost a prompt after valid streamed output | Product failure |
| Injected disconnect did not leave UI recoverable | Product failure |
| Provider credential expired | Infrastructure/configuration failure |
| Real provider returned rate limit within declared expectations | Provider/infrastructure signal, not automatically product failure |
| Drive emitted output after its own terminal plan | Harness or Drive defect |

Classification rules live in configuration/code and are versioned. They should
not rely on free-form error-string matching when typed tags or protocol events
are available.

## Testing the Strategy Layer

Unit tests should cover:

- schema decoding of every plan variant;
- terminal-event validation;
- title routing;
- offered-tool extraction;
- deterministic choice for the same seed;
- response trace recording;
- fault insertion at every supported point;
- budget exhaustion;
- cancellation during provider streaming;
- redaction and summary construction.

Use `it.effect.prop` for generated response-plan laws. Useful properties:

- generated streams contain at most one terminal event;
- no item occurs after a terminal event;
- every generated tool name belongs to the offered set;
- encoded and decoded response plans round-trip;
- step and token budgets bound the stream;
- replaying a recorded choice trace yields the same logical output.

Integration tests should run plans through the actual `LlmController` and a
transport peer, reusing the package's current simulation tests. A small number
of live OpenCode tests validates end-to-end projection.

## Acceptance Criteria

Inference simulation is ready for continuous operation when:

- every deterministic journey records a plan digest;
- queued and served strategies cannot share one lane accidentally;
- unexpected and unused exchanges terminalize the attempt visibly;
- title requests never consume normal queued responses;
- every deliberate fault is distinguishable from an unexpected failure;
- actual output type/chunk/timing summaries are captured;
- generated behavior is replayable from a seed plus recorded choice/chunk
  trace;
- no strategy can exceed its time, step, or output budget;
- a real-provider strategy can be disabled globally without changing
  deterministic lanes;
- no new backend-control CLI command or Drive-only protocol field is added.
