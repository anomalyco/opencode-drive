# Environments and Lanes

This document defines how OpenCode revisions are deployed for continuous
verification, which state persists, how work is isolated, and how concurrency
is scaled safely.

The key distinction is:

- an **environment** represents a promotion target or comparison set;
- a **lane** is one executable lifecycle and concurrency boundary inside that
  environment.

## Environment Model

An environment groups everything needed to make a release decision about one
or more OpenCode revisions.

Examples:

- `v2-candidate`: current `origin/v2` revision under test;
- `baseline-candidate`: stable and candidate revisions tested side by side;
- `nightly-main`: one nightly commit with extended property and chaos budgets;
- `developer-pr-1234`: temporary environment for a branch or pull request.

An environment records:

- stable environment ID;
- exact OpenCode commit SHA for each variant;
- source repository identity;
- Drive revision or package version;
- lane specifications;
- configuration version;
- creation and retirement timestamps;
- promotion policy and required lane classes.

Human-friendly branch names are labels, not identities. Every attempt records
the immutable commit SHA resolved when the environment was provisioned.

## Lane Definition

A lane owns:

- one artifact root;
- one project fixture and OpenCode configuration;
- one OpenCode server generation at a time;
- one database policy;
- one simulated-model controller with one active response-routing mode for its
  lifetime;
- one active Drive tool-controller attachment and registration generation;
- zero or more attempt-owned TUI processes;
- one concurrency limit;
- one health policy and one set of rules for replacing the lane generation.

A lane is deliberately narrower than “all tests for this revision.” It is the
smallest unit that can be restarted, drained, compared, or declared unhealthy
without creating response-routing ambiguity.

### Response-routing mode, in plain language

Drive can answer model requests in two fundamentally different ways:

- **queued mode**: a scenario loads response A, response B, and response C;
  model requests consume them in that order;
- **served mode**: one request-aware function receives each model request and
  decides what response to stream.

The current `LlmController` does not allow a controller to start queueing
responses and later install a served handler. Therefore a queued-journey lane
and a reactive/property lane use different controller lifetimes. This bullet
does **not** mean one real AI model or one provider per lane.

### Tool-controller attachment, in plain language

Drive can intercept selected OpenCode tools—currently built-in shapes such as
`shell`, `webfetch`, `websearch`, and `write`—and let the test decide when each
call reports progress, succeeds, fails, or is interrupted.

The lane owns one active controller connection. At a clean attempt boundary it
may install an attempt's complete tool profile, for example:

```text
ordinary smoke
  no controlled tools

tool-success journey
  control write; return a deterministic result

interruption journey
  control shell; hold it open until the test interrupts it
```

Only one registration generation is active at a time, so one attempt cannot
silently replace the handlers while another attempt is using them. The earlier
phrase “one tool-control configuration” did not mean that every journey in the
lane must use the same tools forever.

### Replacing or recycling a lane, in plain language

A persistent lane is long-lived, but not immortal. **Recycling** means:

1. stop assigning new attempts;
2. finish or explicitly interrupt the current attempt;
3. collect required evidence;
4. shut down the TUI, controllers, and OpenCode server;
5. verify that processes, ports, and scoped resources are gone;
6. start a new lane generation and run its bootstrap smoke.

The rules that trigger this replacement are the recycle policy. Examples are a
new OpenCode commit, changed configuration/protocol, a maximum lane age,
resource growth, failed health checks, or a lane frozen after failure evidence
is secured. Recycling is not retrying a scenario, and it never deletes or
rewrites the failed attempt.

## Recommended Initial Lane Types

### Persistent queued-journey lane

Purpose:

- run deterministic catalog journeys frequently;
- keep the same server alive across attempts;
- reveal session accumulation and long-lived resource problems.

Properties:

- inference mode: `queue`;
- attempt concurrency: `1`;
- fresh TUI and session per attempt;
- persistent server and selected database;
- fixture files reset between ordinary journeys;
- deterministic response plan authored by the scenario.

This is the first lane to implement.

### Persistent reactive lane

Purpose:

- run request-aware inference handlers;
- execute subagent flows;
- host stateful model-based campaigns.

Properties:

- inference mode: `serve`;
- attempt concurrency: `1` initially;
- handler routes by request body, session metadata, and active campaign state;
- fresh TUI/session unless a campaign declares reuse;
- separate from queued journeys because the controller response modes are
  mutually exclusive.

### Stateful-property lane

Purpose:

- generate many valid mid-flight action sequences;
- test invariants after every transition;
- accumulate a reproducible corpus of seeds.

It may initially be implemented as a specialized reactive lane. It becomes a
separate lane class when its longer attempt deadlines and adaptive scheduling
would interfere with deterministic journey freshness.

### Chaos lane

Purpose:

- inject server, provider, tool, network, and timing failures;
- verify declared recovery invariants;
- keep expected disruption away from the smoke signal.

Properties:

- explicit fault budget;
- no simultaneous unrelated experiment in the same lane;
- a supervisor capable of manual server kill/relaunch;
- stronger evidence capture and longer cooldown;
- never used as the only functional-health lane.

### Real-inference canary lane

Purpose:

- verify the integration with one real provider;
- detect provider API, authentication, streaming, tool-call, and cost drift;
- compare deterministic product health with realistic model behavior.

Properties:

- low cadence and strict token/cost budget;
- dedicated credentials and egress policy;
- semantic or externally observable assertions, not exact output strings;
- no use as the sole release gate until its variance is understood.

This lane is intentionally later than deterministic mock coverage.

### Ephemeral reproduction lane

Purpose:

- rerun one failed attempt in a fresh environment;
- compare persistent-state and clean-state behavior;
- support developer-triggered replay by scenario address and seed.

Properties:

- created with the existing safe `OpenCodeDriver.use` lifecycle;
- exact revision, fixture, config, response plan, and seed from the source
  attempt;
- artifacts retained regardless of pass or fail;
- result linked to, but never replacing, the source attempt.

## Why Queue and Serve Need Separate Lanes

The existing LLM controller exposes `queue`, `send`, and `serve`. Queued output
uses ordered matching between requests and response plans. A served handler
reacts to each request. The controller rejects mixing modes after one is
selected.

This property is useful, not a limitation to erase. It makes a lane's response
semantics predictable.

Trying to share one controller across unrelated concurrent queued journeys
would create ambiguity: the next request from TUI B could consume the response
authored for TUI A. Request-aware serving can support more concurrency later,
but only after session routing and handler state are explicitly designed.

The initial rule is therefore:

> One active attempt per lane. Add throughput by adding lanes.

This is operationally simple and matches the current catalog runner, which
keeps scenario steps sequential while running independent variants in separate
processes.

## Lifetime and Isolation Matrix

| Resource | Ordinary persistent lane | Dedicated reuse experiment | Ephemeral reproduction |
| --- | --- | --- | --- |
| Host/pod | Persistent | Persistent | Attempt or short batch |
| Lane supervisor | Persistent | Persistent | Attempt |
| OpenCode server | Persistent across attempts | Persistent across attempts | Attempt |
| Database | Persistent by policy | Persistent | Attempt unless replay requires snapshot |
| Project artifact root | Lane generation | Lane generation | Attempt |
| Fixture files | Reset before attempt | Experiment-defined | Fresh |
| Model controller | Server generation | Server generation | Attempt |
| TUI | Fresh per attempt | Reused only if declared | Fresh |
| Session | Fresh per attempt | Reused only if declared | Fresh |
| Tool invocations | Call-scoped | Call-scoped | Call-scoped |
| Attempt evidence writer | Attempt | Attempt | Attempt |

“Persistent” never means immortal. Every persistent resource has a generation
ID, start timestamp, owner process, and explicit recycle path.

## Database Policies

Drive uses an in-memory OpenCode database by default. A 24/7 environment needs
an explicit lane policy.

### Memory database

Use for:

- ephemeral reproduction;
- deterministic smoke while the persistence contract is not under test;
- fast isolated diagnosis.

The database disappears on server restart. Recovery scenarios must not expect
session continuity under this policy.

### File-backed lane database

Use for:

- long-lived soak lanes;
- restart and rehydration scenarios;
- session-accumulation observation.

The database path resolves inside the isolated artifact root through
`OPENCODE_DRIVE_DB`. Each lane uses its own file. Never point several lane
processes at the same database unless OpenCode explicitly supports that
topology and the test is designed for it.

### Snapshot-based reproduction

Later, a failed persistent attempt may publish a redacted database snapshot.
An ephemeral reproduction lane can restore it before replay. Snapshot restore
is optional evidence, not a prerequisite for the first release. It requires
strong retention and secret-redaction rules.

## Fixture Isolation

Catalog scenarios currently share a small project fixture and reset mutated
files between journeys. Continuous verification should extract that behavior
into one explicit preparation operation.

An ordinary attempt preparation must:

1. Verify that the lane generation is still current.
2. Close any stale attempt TUI left by reconciliation.
3. Restore declared fixture files atomically where practical.
4. Remove scenario-owned transient files.
5. Preserve lane-owned OpenCode state and database files.
6. Create a new session through observable UI or SDK behavior.
7. Verify the composer is actionable before starting the timed journey.

Do not use `git reset --hard` against an unresolved or broad path from a
long-running process. Prefer an explicit fixture manifest or a prepared
directory swap whose target is validated inside the lane artifact root.

## Client Isolation

The existing executable-scenario metadata distinguishes shared and isolated
clients. Continuous verification interprets it as follows:

- `shared` means scenarios may execute sequentially through one attempt client
  when the runner intentionally batches them;
- `isolated` means the scenario receives a freshly launched TUI and the TUI is
  closed after the scenario;
- the default monitoring behavior should still favor one scenario per attempt,
  because that produces clearer latency, evidence, and failure attribution.

Batching is an optimization and a special soak dimension, not the first
operational model.

## Revision Preparation

The catalog capture system already resolves revisions to immutable commits and
prepares detached worktrees. Continuous verification should reuse the same
principles:

1. Resolve a configured ref to a commit SHA.
2. Record ref, SHA, commit timestamp, and source checkout identity.
3. Prepare dependencies with the lockfile enforced.
4. Validate the OpenCode simulation capabilities before marking the lane
   ready.
5. Never mutate the prepared source checkout during attempts.
6. Use a separate artifact/project directory for runtime writes.

Prepared source worktrees may be cached. Cache identity is the immutable
revision plus relevant build inputs, not a branch name.

## Environment Promotion

A safe candidate rollout is:

```text
resolve revision
      |
      v
provision candidate lanes
      |
      v
protocol/readiness probe
      |
      v
short deterministic smoke
      |
      v
activate scheduled journeys
      |
      v
observe required window
      |
      +--> promote
      |
      +--> drain and retain evidence
```

Baseline lanes remain active during the observation window when comparison is
important. Candidate failures can then be compared against the same scenario
on the baseline revision without changing the source attempt.

Promotion policy should name required signals, for example:

- protocol negotiation succeeded;
- five consecutive smoke attempts passed;
- no required journey failed in the last hour;
- no property invariant failed in the configured campaign budget;
- resource slope stayed below the soak threshold;
- evidence pipeline remained healthy.

## Lane Specification

The persisted lane specification should be schema-backed. The following is an
illustrative proposed shape, not an existing public API:

```ts
import { Schema } from "effect"

const LaneKind = Schema.Literals([
  "queued-journey",
  "reactive",
  "property",
  "chaos",
  "real-inference",
  "reproduction",
])

const DatabasePolicy = Schema.Literals([
  "memory",
  "file",
  "restored-snapshot",
])

export class LaneSpec extends Schema.Class<LaneSpec>("LaneSpec")({
  id: Schema.String,
  environmentId: Schema.String,
  kind: LaneKind,
  revision: Schema.String,
  database: DatabasePolicy,
  concurrency: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  viewport: Schema.Struct({
    cols: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    rows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  maxAttemptMilliseconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
  ),
  recycleAfterAttempts: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
  recycleAfterMilliseconds: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
}) {}
```

Important configuration choices such as permission policy, tool controls,
theme, and inference strategy either belong directly in the lane spec or in a
separately versioned referenced configuration. They must not exist only as
unrecorded environment variables.

## Lane Eligibility

Before leasing work, the lane pool checks:

- lane state is `ready`;
- lane has an unused concurrency permit;
- OpenCode revision matches the work specification;
- response mode matches the scenario;
- required tools and protocol capabilities are available;
- database and reuse policies satisfy the scenario;
- no incompatible chaos experiment is active;
- remaining cost and resource budgets are sufficient;
- lane is not scheduled to drain before the attempt deadline.

Eligibility failures do not count as scenario failures. They are scheduling or
capacity signals and can become an incident if they prevent freshness SLOs.

## Health and Heartbeats

Each lane publishes:

- supervisor process identity;
- lane generation ID;
- last heartbeat timestamp;
- current state;
- OpenCode process identity and uptime;
- active attempt ID, if any;
- last successful readiness probe;
- last successful smoke attempt;
- current resource measurements;
- last recycle reason;
- protocol compatibility summary.

Heartbeats must be written by the lane supervisor, not inferred solely from
OpenCode logs. The control plane detects missing heartbeats independently.

## Recycling Policy

There are two competing goals:

- keep lanes alive long enough to expose lifetime bugs;
- recycle before unrelated resource exhaustion makes the environment useless.

Use different policies for different lanes:

- at least one **true soak lane** recycles only on rollout, explicit
  maintenance, or unrecoverable failure;
- ordinary journey lanes may recycle after a high attempt count or maintenance
  window;
- chaos lanes recycle after experiments that intentionally invalidate their
  baseline;
- real-inference lanes may recycle with credential or provider configuration
  rotation.

Every recycle records a reason. A policy recycle is not a crash; a resource
threshold recycle is an operational warning and retains pre-recycle metrics.

## Recovery Policy

On unexpected server exit:

1. Mark the active attempt with the observed exit evidence.
2. Classify it as product or infrastructure failure based on experiment and
   host context; use `inconclusive` when attribution is unsafe.
3. Close attempt-owned resources.
4. Increment lane generation.
5. Apply bounded, jittered infrastructure retry policy.
6. Relaunch and perform protocol/readiness probes.
7. Return to `ready` only after the probe succeeds.
8. Escalate if the retry budget or freshness SLO is exhausted.

Do not automatically replay the failed state-changing journey in the same
attempt. A diagnostic reproduction is separately scheduled.

## Capacity Planning

Initial capacity can be estimated from:

- total journey duration per schedule interval;
- one active attempt per lane;
- property and chaos attempt duration percentiles;
- startup and recycle cost;
- desired baseline/candidate duplication;
- host CPU and memory per OpenCode server/TUI pair.

If one queued journey lane takes 20 minutes to complete work scheduled every 10
minutes, it is undersized even if the server is healthy. Add a lane, reduce
cadence, or shorten the matrix. Do not hide the backlog with overlapping queued
responses in one controller.

## Recommended First Environment

```text
environment: v2-continuous

lane: v2-queue-1
  kind: queued-journey
  server: persistent
  database: file
  concurrency: 1
  journeys: smoke + deterministic catalog flows

lane: v2-reactive-1
  kind: reactive/property
  server: persistent
  database: file
  concurrency: 1
  journeys: subagent + seeded lifecycle campaign

lane: v2-repro
  kind: reproduction
  lifecycle: ephemeral
  concurrency: 1
  work: on-demand failed-attempt replay
```

Add a chaos lane only after the smoke and evidence paths are trustworthy. Add a
real-inference lane only after deterministic product failures and provider
variance are distinguishable in dashboards and alerts.

## Acceptance Criteria

The lane subsystem is ready for the first 24/7 deployment when:

- one server remains alive across at least 100 sequential attempts;
- every attempt gets a distinct TUI identity and session;
- fixture reset is verified and cannot escape the lane artifact root;
- queue and serve work cannot be scheduled onto the wrong lane;
- unexpected server exit produces a terminal attempt and a new lane generation;
- heartbeat absence is detected from outside the lane process;
- lane shutdown closes every TUI and server process;
- an ephemeral reproduction can run the same scenario at the exact revision;
- the run record identifies all relevant lifetimes and generation IDs.
