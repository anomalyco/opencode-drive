# Bot Orchestration

This document defines how continuous-verification bots select work, lease
lanes, execute attempts, handle deadlines, recover from coordinator failure,
and shut down safely.

A bot is a deterministic orchestrator unless a scenario explicitly asks for
generated behavior. Calling it a bot describes its autonomous, recurring
operation; it does not imply that another LLM is deciding what to do.

## Responsibilities

The orchestration subsystem owns:

- recurring schedules and campaign budgets;
- scenario eligibility and lane matching;
- leases and concurrency limits;
- attempt IDs and attempt state transitions;
- end-to-end deadlines;
- cancellation and draining;
- retry and reproduction requests;
- checkpoint timing wrappers;
- evidence collection coordination;
- stale-attempt reconciliation;
- liveness and progress heartbeats.

It does not own:

- OpenCode-specific scenario steps;
- model-output construction;
- UI protocol definitions;
- tool implementation semantics;
- telemetry exporter configuration;
- alert-delivery provider details.

## Bot Identities and Worker Processes

A **bot** is a durable logical test profile with its own purpose, cadence,
freshness objective, owner, and coverage report. It does not need one permanent
operating-system process.

Examples:

- `journey.smoke.queued` continuously runs essential catalog flows;
- `journey.recovery.reactive` runs interruption and recovery flows;
- `property.session-lifecycle` explores generated session transitions;
- `provider.openai.responses.native` owns the native OpenAI Responses contract;
- `provider.anthropic.messages.native` owns the Anthropic Messages contract;
- `provider.bedrock.converse.native` owns Bedrock request/framing behavior;
- `provider.azure.responses.native` owns Azure Responses construction and
  transport cases;
- `provider.<package>.aisdk-fallback` owns an actual external AI SDK package and
  the canonical adapter path;
- `provider.live.<provider>` runs a sparse budgeted drift probe.

The scheduler materializes each bot's next work item. A shared worker pool may
execute many provider bots because their contract cases are finite and
ephemeral. Persistent journey/soak bots lease compatible long-lived lanes.

This separation gives one visible health row per provider/package without
paying for one idle process or OpenCode server per provider. Run a dedicated
process only when isolation, credentials, native dependencies, or concurrency
require it.

A bot definition contains:

```text
BotDefinition
  id
  kind
  owner
  target selector
  case/scenario selector
  lane requirements
  cadence and freshness objective
  concurrency
  timeout/resource/cost budgets
  credential/network profile
  evidence and alert policy
  enabled/quarantine state
  definition version/digest
```

Bot status is derived from durable attempts and schedule state, not from the
existence of a process named after it. A bot can therefore be `healthy`,
`failing`, `stale`, `blocked`, `disabled`, or `quarantined` independently of
the worker pool.

## Units of Work

### Schedule entry

A schedule entry says when and under which policy a scenario should run.

Proposed fields:

- schedule entry ID;
- scenario or campaign ID;
- cadence policy;
- eligible environment or revision selector;
- eligible lane kinds;
- priority;
- maximum queue age;
- attempt timeout;
- retry classification policy;
- alert policy;
- enabled/disabled state;
- optional start and end windows.

### Work specification

A work specification is an immutable decision to run one scenario or campaign.
It records:

- generated work ID;
- source schedule entry or manual trigger;
- target environment/revision;
- scenario ID;
- inference strategy;
- optional seed and step count;
- optional chaos plan;
- required protocol capabilities;
- timeout and evidence policy;
- creation timestamp and expiration.

### Attempt

An attempt is one execution of a work specification on one concrete lane.
Retries and reproductions create new attempts linked to the source attempt.

This distinction prevents a retry from rewriting reliability history. One work
item may have multiple attempts, but each attempt has one immutable outcome.

## Scheduler Design

Timing policy should use Effect `Schedule`, not ad hoc `while` loops containing
mutable counters and sleeps.

Recommended policies:

- fixed or windowed cadence for smoke journeys;
- spaced cadence for ordinary journey cycles;
- cron cadence for nightly extended campaigns;
- jittered cadence across equivalent lanes to avoid synchronized load;
- bounded campaign iteration count for property tests;
- explicit cooldown after a chaos experiment.

Example intent:

```text
smoke                 every 60 seconds, aligned, small jitter
critical journeys     every 5 minutes
full journey matrix   every 30 minutes
property campaign     100 seeds per hour
reconnect chaos       every 6 hours
extended soak report  once per day
real provider canary  every 30 minutes with a daily token budget
```

Schedules produce due work. They do not wait synchronously for a particular
lane. Due work enters a bounded queue or durable work table. Backlog age is
observable and can violate freshness SLOs even when individual attempts pass.

## Fairness and Priority

The initial priority order should be:

1. heartbeat/readiness probes;
2. smoke journeys required for freshness;
3. diagnostic reproduction requested for an active incident;
4. critical deterministic journeys;
5. ordinary journey matrix;
6. property campaigns;
7. chaos and exploratory work.

Lower-priority campaigns use quotas so they cannot starve indefinitely. A
simple approach is weighted round-robin across priority classes after reserving
capacity for smoke work.

Do not let a large property campaign insert thousands of independent work rows
at once. Persist a campaign cursor and issue only enough seeds to fill the
configured concurrency window.

## Lane Leasing

A lane lease prevents overlapping attempts from consuming one simulation
controller or workspace unexpectedly.

A lease contains:

- lease ID;
- lane ID and lane generation ID;
- attempt ID;
- owner process identity;
- acquisition timestamp;
- expiration timestamp;
- renewal timestamp;
- concurrency slot number when the lane supports more than one.

The first implementation uses one slot per lane. The design retains a slot
field so higher concurrency can be introduced without changing record
identity.

Lease operations are idempotent:

- acquiring for an already-owned attempt returns the same lease;
- renewal verifies owner and lane generation;
- release succeeds if the lease is already absent;
- a generation change invalidates every lease from the previous generation.

A heartbeat fiber renews the lease while the attempt runs. Losing the lease
interrupts the attempt; it does not allow uncoordinated execution to continue.

## Attempt Lifecycle

The coordinator implements one named business operation, conceptually
`AttemptCoordinator.execute`.

### 1. Decode and validate

Decode the work specification through Effect Schema. Check that the scenario
exists and that requested inference, chaos, and database policies are
compatible.

Validation failures are typed scheduling failures. They do not start a lane or
count as product failures.

### 2. Allocate attempt identity

Create an immutable attempt ID before acquiring mutable resources. Persist a
`scheduled` event with the exact configuration and source work ID.

### 3. Acquire a compatible lane

Ask `LanePool` for a lane satisfying the scenario requirements. Persist the
lease and transition to `leased`.

If no capacity exists before the work expires, terminalize as
`infrastructure_failed` or a more specific scheduling failure. Do not call it a
scenario timeout because scenario execution never began.

### 4. Prepare attempt resources

Within an attempt scope:

- verify lane generation;
- restore the project fixture;
- launch a named TUI;
- negotiate UI capabilities;
- create or navigate to a fresh session;
- start the local evidence manifest;
- install attempt correlation annotations.

Preparation has its own deadline and failure classification.

### 5. Execute the scenario

Run the scenario with:

- the adapted `Driver` whose `ui` points at the attempt TUI;
- the configured inference strategy;
- a checkpoint callback that records timing and optional frames;
- the attempt deadline;
- concurrent observation of lane/server failure.

The current `OpenCodeDriver.use` already races user work with driver failure and
performs settlement at its safe lifecycle boundary. A persistent lane needs the
same principle at attempt granularity: scenario work races lane-generation
failure, while the lane itself remains alive after an ordinary scenario
failure.

### 6. Collect evidence

On success, collect the compact configured evidence. On failure, capture the
failure bundle before releasing the TUI when possible. Evidence failure is
recorded separately from the primary outcome.

### 7. Classify outcome

Inspect typed errors and, only at the coordinator boundary, the full Effect
`Cause` when defects or interrupts must be distinguished.

Possible terminal classifications are defined in
[Observability and evidence](./08-observability-and-evidence.md).

### 8. Release resources

The attempt scope closes:

- recording timeline;
- simulation client associated with the TUI;
- TUI process;
- local evidence writer;
- lease-renewal fiber;
- lane lease.

Cleanup errors are appended to the attempt cause/evidence. They do not hide the
primary scenario failure.

### 9. Emit follow-up work

Policy may request:

- no follow-up;
- one diagnostic retry in the same persistent lane;
- one clean ephemeral reproduction;
- an expanded property campaign near the failing seed;
- lane recovery or quarantine.

Every follow-up receives a new attempt ID and a typed relationship to the
source attempt.

## Checkpoint Wrapper

Catalog scenarios receive a capture callback for each ordered state. The
monitoring adapter uses that callback as a checkpoint boundary.

For every checkpoint:

1. verify the attempt and lane generation are current;
2. record monotonic elapsed time and wall-clock timestamp;
3. append checkpoint status to the run store;
4. annotate the current span with checkpoint address and ordinal;
5. optionally capture a frame according to evidence policy;
6. update attempt progress heartbeat;
7. return control to the scenario.

Checkpoint persistence should be idempotent by attempt ID and ordinal. A
duplicate callback with a different address is a harness invariant violation.

## Timeouts

Use layered deadlines rather than one opaque timeout:

| Deadline | Purpose | Example reaction |
| --- | --- | --- |
| Queue age | Work waited too long for capacity | Freshness/capacity incident |
| Lane acquisition | Lease could not be obtained | Reschedule or fail scheduling |
| Preparation | TUI/session never became ready | Lane recovery and evidence |
| Scenario | End-to-end journey exceeded budget | Capture frame/events, classify |
| Checkpoint wait | One observable state did not arrive | Existing typed UI timeout |
| Evidence collection | Capture/upload is stuck | Preserve local bundle, mark evidence degraded |
| Graceful cleanup | Process refuses to close | Escalate termination and record cleanup failure |

Timeouts produce typed errors. They are not generic strings, and they retain
which phase and checkpoint were active.

## Retry Policy

Retries have different semantics by failure class.

### Never retry invisibly

State-changing operations such as submit, click, approve, reject, or tool
completion are not retried inside an attempt. The system cannot generally know
whether the first operation committed before transport failure.

### Retry safe infrastructure preparation

Safe, idempotent infrastructure operations may use bounded retries:

- artifact upload by content digest;
- heartbeat publication;
- read-only lane-health queries;
- opening a connection before any work is submitted;
- rebuilding an immutable source checkout.

Use `Effect.retry` with a `Schedule`, retry only known retryable error tags, add
jitter for distributed workers, and expose attempt metadata in telemetry.

### Retry a whole journey as a new attempt

Policy may schedule a new attempt when:

- an assertion appears intermittent;
- a clean-state comparison is useful;
- an infrastructure failure has recovered.

The original failure remains visible. A pass on retry changes diagnosis, not
history.

### Do not retry deterministic product failures automatically forever

Repeated retries create load and alert noise without adding information. After
one persistent and one clean reproduction, deduplicate the incident and reduce
cadence until the revision or scenario changes.

## Cancellation

Cancellation sources include:

- operator request;
- environment drain;
- lost lease;
- attempt deadline;
- lane generation failure;
- process supervisor shutdown.

Effect interruption is the cancellation mechanism. The coordinator records
who requested cancellation and why, then interrupts the attempt fiber. Scoped
finalizers perform cleanup.

Cancellation is not caught and converted to success. The terminal record is
`cancelled` unless another primary failure was already committed.

## Draining

When a lane or environment begins draining:

1. scheduler stops assigning new work;
2. queued work is redirected or remains pending;
3. active attempts receive a grace deadline;
4. long property or soak attempts may checkpoint and stop at a safe boundary;
5. attempts exceeding grace are interrupted;
6. leases are released;
7. lane shutdown proceeds.

Draining state and deadlines are visible in lane heartbeats.

## Reconciliation

The control plane periodically scans for inconsistent state:

- `leased` attempt with expired lease;
- `running` attempt with no progress heartbeat;
- lane heartbeat missing while it owns an attempt;
- terminal attempt that still has an active lease;
- non-terminal attempt referencing an old lane generation;
- artifact upload pending beyond its budget;
- due schedule with no issued work;
- campaign cursor not advancing.

Reconciliation is conservative. It may mark an attempt `inconclusive` and
release stale coordination records, but it never fabricates a passed outcome.

## Backpressure

Every queue is bounded or durable with an explicit age policy.

- The scheduler does not generate unbounded future work.
- The attempt worker takes only work for which it can acquire capacity.
- Evidence upload uses a bounded local spool.
- Telemetry exporter backpressure cannot block lane cleanup indefinitely.
- Property campaigns issue a small rolling window of seeds.
- Alert delivery retries are bounded and deduplicated.

Backlog depth and oldest-item age are metrics. Dropping low-priority work is an
explicit event with a reason, not silent loss.

## Proposed Effect Services

The following code is an illustrative architecture sketch, not a committed
public API:

```ts
import { Context, Effect, Scope } from "effect"

export class Scheduler extends Context.Service<Scheduler, {
  readonly take: Effect.Effect<WorkSpecification, SchedulerError>
}>()("ContinuousVerification/Scheduler") {}

export class LanePool extends Context.Service<LanePool, {
  readonly acquire: (
    attempt: AttemptIdentity,
    requirements: LaneRequirements,
  ) => Effect.Effect<LaneLease, LaneUnavailable, Scope.Scope>
}>()("ContinuousVerification/LanePool") {}

export class RunStore extends Context.Service<RunStore, {
  readonly createAttempt: (
    attempt: AttemptRecord,
  ) => Effect.Effect<void, RunStoreError>
  readonly appendEvent: (
    event: AttemptEvent,
  ) => Effect.Effect<void, RunStoreError>
}>()("ContinuousVerification/RunStore") {}

export class AttemptCoordinator extends Context.Service<
  AttemptCoordinator,
  {
    readonly execute: (
      work: WorkSpecification,
    ) => Effect.Effect<AttemptOutcome, AttemptExecutionError>
  }
>()("ContinuousVerification/AttemptCoordinator") {}
```

In real code, all referenced models and errors should be Schema classes or
schema-backed tagged errors because they cross persistence and process
boundaries.

The main worker workflow remains small:

```ts
const worker = Effect.fn("ContinuousVerification.worker")(function* () {
  const scheduler = yield* Scheduler
  const coordinator = yield* AttemptCoordinator
  const work = yield* scheduler.take
  yield* coordinator.execute(work)
})
```

Recurring execution applies a schedule at the worker boundary. Layer
composition, telemetry, platform services, and runtime execution occur once at
the application entrypoint.

## Process Topology

The first deployment can use:

- one scheduler/control process;
- one lane-supervisor process per lane;
- one external supervisor such as systemd, Docker, or Kubernetes;
- one durable run store;
- one artifact root/spool per lane;
- one telemetry collector reachable by every process.

The scheduler and lane supervisor may initially share code and configuration,
but should remain distinct process roles. If a lane process deadlocks while
driving OpenCode, the scheduler must still observe the missing heartbeat.

## Testing the Orchestrator

Use `@effect/vitest` and explicit layers.

Unit coverage should include:

- cadence and jitter using `TestClock`;
- priority and fairness;
- bounded campaign issuance;
- lease acquisition, renewal, expiry, and generation invalidation;
- every attempt state transition;
- idempotent checkpoint writes;
- timeout classification by phase;
- cancellation and finalizer execution;
- retry creation without source-attempt mutation;
- reconciliation of abandoned attempts;
- backpressure and queue expiration.

Property tests should generate attempt-event sequences and assert that the
state projection never transitions from a terminal state, never owns two
exclusive leases, and never reports `passed` without a completed scenario.

Integration coverage should use a fake lane layer first, then one real Drive
lane for lifecycle characterization. Tests that share a resource layer use the
`layer(...)` helper; tests requiring isolated instances use separate
`it.layer(...)` blocks.

## Operational Metrics

The orchestrator publishes at least:

- work issued by schedule and scenario;
- pending work count and oldest age;
- lane acquisition wait duration;
- active attempts;
- attempt phase duration;
- lease renewal failures;
- reconciled abandoned attempts;
- retries and reproductions requested;
- work expired or dropped by reason;
- campaign seeds issued and completed;
- scheduler heartbeat age.

Keep identifiers such as attempt ID out of metric labels. They belong in spans,
logs, and run records.

## Acceptance Criteria

The first orchestrator is ready when:

- schedules run deterministically under `TestClock`;
- work never overlaps on a one-slot lane;
- a killed worker leaves an expired lease that reconciliation resolves;
- a scenario timeout captures evidence and releases its TUI;
- a retry appears as a linked new attempt;
- product failures are not retried as infrastructure operations;
- draining stops new work and closes active resources within a bound;
- queue age and missing progress can independently alert;
- the worker can run for 24 hours without growing an unbounded in-memory queue;
- all major workflows appear as named Effect spans.
