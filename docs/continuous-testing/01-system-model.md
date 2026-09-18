# System Model

This document defines the conceptual architecture of OpenCode continuous
verification. It focuses on ownership, lifetimes, failure domains, and the
contract between the always-on control plane and the OpenCode processes being
tested.

Read [Environments and lanes](./02-environments-and-lanes.md) next for the
concrete lane types and isolation rules.

## Objectives

The system must:

1. Keep at least one real OpenCode environment available continuously.
2. Exercise that environment with realistic TUI and SDK interactions.
3. Support deterministic mock inference before introducing real providers.
4. Explore fixed journeys and generated state-machine transitions.
5. Detect correctness failures, stuck work, crashes, recovery failures, and
   performance regressions.
6. Preserve enough evidence to diagnose and replay failures.
7. Distinguish a product failure from a harness, infrastructure, or assertion
   failure.
8. Continue reporting health when the OpenCode workload is unavailable.
9. Operate safely for long periods without unbounded storage, cost, or process
   growth.

## Non-Objectives

The first system is not:

- a production OpenCode hosting platform;
- a generic cloud scheduler inside `packages/drive`;
- a load test that tries to maximize requests per second;
- a replacement for unit, integration, or pull-request tests;
- a new model-provider abstraction in the Drive CLI;
- a promise that arbitrary generated agent output can be judged perfectly;
- a multi-tenant environment for untrusted external users;
- a reason to weaken the canonical OpenCode simulation protocol.

## The Two-Plane Model

The most important architectural separation is between the **control plane**
and the **workload plane**.

```text
CONTROL PLANE                              WORKLOAD PLANE

configuration                              OpenCode server
scenario registry                          TUI process(es)
scheduler and leases       commands         SDK client
attempt coordinator   ------------------>   simulated inference
run and checkpoint store                    controlled tools
artifact index          <----------------   project and database
telemetry collector       observations      frames and recordings
alert evaluator
```

The workload plane is expected to fail. It is the object under test. The
control plane must therefore not share the same fate accidentally.

For the first implementation, both planes may run on one machine, but they
remain separate processes and persistence domains. A lane crash must leave a
heartbeat gap or exit record that another process can observe.

## Components

### Scenario registry

**Status: existing foundation, proposed monitoring metadata.**

The authoritative OpenCode journey registry is
[`apps/catalog/scenarios/index.ts`](../../apps/catalog/scenarios/index.ts).
Each executable scenario already declares:

- a stable flow ID;
- ordered states and checkpoint addresses;
- a response mode (`queue` or `serve`);
- a client-isolation policy;
- an Effect program that drives a real OpenCode instance.

Continuous verification adds scheduling and operational metadata around that
registry. It does not create a competing registry. Examples of proposed
metadata are cadence, timeout, required lane capabilities, risk level, and
alert policy.

### Scheduler

**Status: proposed.**

The scheduler decides which scenario or campaign is due. It emits work only
when an eligible lane has capacity. It is responsible for cadence, fairness,
jitter, disabled scenarios, and campaign budgets.

It is not responsible for interpreting UI state or generating LLM chunks. Those
remain scenario and inference responsibilities.

### Attempt coordinator

**Status: proposed.**

The coordinator owns the lifecycle of one attempt:

1. Validate the work specification.
2. Acquire a compatible lane lease.
3. Create an immutable attempt record in `scheduled` state.
4. Prepare a fresh TUI/session or the explicitly requested reuse mode.
5. Execute the scenario with a deadline.
6. Record every reached checkpoint.
7. Capture failure evidence before cleanup.
8. Classify the outcome.
9. Release attempt-owned resources and the lane lease.
10. Emit metrics and evaluate alert policy.

An attempt coordinator never silently reruns a failed UI action. If policy
requests a retry, it schedules a new linked attempt.

### Lane supervisor

**Status: proposed orchestration over existing Drive lifecycles.**

A lane supervisor owns one persistent OpenCode environment. It starts the
server, attaches model and tool control, reports readiness, creates attempt
clients, observes process exits, and shuts everything down cooperatively.

The existing
[`OpenCodeDriver`](../../packages/drive/src/driver/index.ts) and
[`defineScript`](../../packages/drive/src/script/types.ts) lifecycles provide
the process and resource foundation. The continuous system adds the outer
supervision and repeated-attempt policy.

### Inference strategy

**Status: deterministic and reactive primitives exist; strategy layer is
proposed.**

The inference strategy turns an opened model exchange into controlled output.
The current controller supports queued output and a request-aware served
handler. The continuous system names, configures, and records the selected
strategy for every attempt.

See [Inference simulation](./04-inference-simulation.md).

### Run store

**Status: proposed.**

The run store persists low-volume, queryable operational truth:

- environments and lanes;
- attempts and their status transitions;
- checkpoints and timings;
- failure classification;
- links between original, retry, and reproduction attempts;
- references to large artifacts;
- alert evaluation state.

Large logs, frames, recordings, and event dumps do not belong directly in the
run store. They belong in the artifact store and are referenced by immutable
descriptors.

### Artifact store

**Status: local artifacts exist; indexed retention is proposed.**

Drive already produces an artifact root, OpenCode logs, terminal frames, and
recordings. The artifact store adds stable naming, manifests, upload/retention,
redaction state, and integrity metadata.

### Telemetry pipeline

**Status: proposed.**

The telemetry pipeline exports structured logs, traces, metrics, and
heartbeats. It should use Effect observability APIs in business code and an
OpenTelemetry layer at the application boundary. The run store remains the
authoritative per-attempt record; telemetry backends remain optimized views.

### Alert evaluator

**Status: proposed.**

The evaluator turns attempt history, heartbeats, and metrics into actionable
notifications. It evaluates both event-based conditions and absence-based
conditions. For example, a server crash is an event; “no successful smoke
attempt in ten minutes” is an absence condition.

## Resource Ownership

Every resource has one owner and one release point.

| Resource | Owner | Typical lifetime | Release condition |
| --- | --- | --- | --- |
| Environment configuration | Control plane | Deployment | Superseded by a versioned config |
| Lane lease | Attempt coordinator | One attempt | Attempt finalizer |
| Lane supervisor process | External process supervisor | Days or weeks | Rollout, maintenance, or crash |
| OpenCode server | Lane scope | Lane generation | Lane recycle or failure |
| Project fixture | Lane scope | Lane generation | Lane recycle |
| Persistent test database | Lane policy | Multiple generations if configured | Explicit retention/rebuild policy |
| Model controller | Lane generation | One server generation | Generation shutdown |
| TUI process | Attempt scope by default | One attempt | Attempt finalizer |
| Session | Attempt by default | Persisted in server database | Retention policy, not TUI cleanup |
| Controlled tool invocation | Tool exchange | One call | Success, failure, interruption, or controller close |
| Recording timeline | TUI scope | One attempt or sampled window | Finish/export during cleanup |
| Attempt record | Run store | Retention period | Archival policy |
| Failure artifact bundle | Artifact store | Longer retention period | Explicit expiration |

Effect scopes should mirror these lifetimes. The lane layer owns the persistent
server and long-lived connections. `Effect.acquireUseRelease` or a scoped
attempt layer owns the TUI and per-attempt evidence writer. The application
runtime owns telemetry exporters and run-store connections.

## Effect Architecture

The proposed control plane is an Effect application. Services are behavioral
dependencies; layers construct and own them. A representative dependency graph
is:

```text
Configuration
    |
    +--> ScenarioRegistry
    +--> Scheduler --------------------+
    +--> RunStore                      |
    +--> ArtifactStore                 v
    +--> AlertSink              AttemptCoordinator
    +--> Telemetry                     |
    +--> LanePool ---------------------+
              |
              +--> scoped LaneSupervisor
                        |
                        +--> OpenCode Drive
```

Recommended service boundaries:

- `ScenarioRegistry`: lookup and eligibility metadata;
- `Scheduler`: due work as a stream or queue;
- `LanePool`: compatible lane acquisition and release;
- `AttemptCoordinator`: one complete attempt workflow;
- `RunStore`: typed attempt and checkpoint persistence;
- `ArtifactStore`: artifact publication and retention metadata;
- `AlertSink`: outbound notification boundary;
- `Heartbeat`: control-plane and lane liveness publication;
- `Telemetry`: configured once as a top-level layer, not called as a domain
  service for every metric.

Service interfaces should remain focused. Do not create one `SoakService` that
contains scheduling, storage, OpenCode lifecycle, metrics, and alerting.

Construction rules:

- pure test doubles use `Layer.succeed`;
- connections and resource-owning implementations use `Layer.effect`;
- startup fibers that expose no service use `Layer.effectDiscard`;
- the final application layer is composed once and provided at the entrypoint;
- parameterized layer factories are called once at the boundary and their
  values are reused so memoization remains effective.

Reusable workflows should use named `Effect.fn` definitions. This produces
useful trace boundaries such as `AttemptCoordinator.execute`,
`LaneSupervisor.launch`, `Scenario.run`, and `Evidence.captureFailure`.

## State Models

### Environment state

An environment is the promotion-level grouping of lanes.

```text
planned -> provisioning -> active -> draining -> retired
              |             |
              v             v
            failed       degraded
```

An environment may remain `active` while one optional lane is degraded. The
promotion policy decides which lane classes are required.

### Lane state

```text
provisioning
    |
    v
  ready <---------- recovering
    |                   ^
    v                   |
  leased ----failure----+
    |                   |
    +------success----> ready
    |
    v
 draining -> stopped
```

`ready` means both that the supervisor is alive and that the lane passed a
readiness probe. A process existing in a registry is not sufficient.

`degraded` is represented as health metadata rather than a separate exclusive
state when the lane can still accept selected diagnostic work. A lane that
cannot safely accept normal work is `recovering` or `draining`.

### Attempt state

```text
scheduled -> leased -> preparing -> running -> collecting -> terminal
                                      |                        |
                                      +--> cancelling ---------+

terminal status:
  passed | product_failed | harness_failed | infrastructure_failed |
  timed_out | cancelled | inconclusive
```

State transitions are append-only events. The current state is a projection.
This makes interrupted coordinators diagnosable and lets a reconciliation
process identify abandoned attempts.

## Failure Domains

A reliable monitoring system identifies where failure originated without
pretending that classification is always perfect.

### Product failure

OpenCode violated an externally observable expectation:

- a prompt disappeared;
- a session projection contradicted the UI;
- a tool never settled;
- the composer stayed unusable after terminal execution;
- the server or TUI crashed due to the exercised behavior;
- a recovery invariant failed after an injected outage.

### Harness failure

The scenario, model plan, assertion, or coordinator was invalid:

- a queued response was unused because the scenario authored the wrong plan;
- a marker changed but the feature remained correct;
- the scenario referenced an impossible state;
- evidence capture itself failed after the primary behavior passed;
- a generated command violated its own precondition.

### Infrastructure failure

The hosting environment failed independently of the OpenCode behavior under
test:

- disk full outside an intentional disk-pressure experiment;
- node eviction;
- telemetry backend outage;
- source checkout or dependency preparation failed;
- artifact upload failed after local evidence was retained.

### Expected injected failure

A chaos action deliberately causes a failure event. The injected event is not
the test failure. Failure occurs only if the declared recovery invariant does
not hold or the blast radius exceeds its envelope.

### Inconclusive

Evidence cannot safely attribute the result:

- the control plane lost contact during a critical observation window;
- both product and host failed simultaneously without enough evidence;
- configuration skew invalidated the expected protocol contract.

Inconclusive attempts count against monitoring freshness and must be visible.
They are not converted to passes.

## Health Model

Health has several independent dimensions:

| Dimension | Example signal |
| --- | --- |
| Supervisor liveness | Heartbeat timestamp and process identity |
| Lane readiness | Simulation handshake, server health, disposable TUI probe |
| Functional health | Recent successful smoke journey |
| Performance health | Time to first output and journey latency windows |
| Resource health | RSS, CPU, file descriptors, disk, event-loop lag |
| Evidence health | Successful local capture and artifact publication |
| Control-plane health | Scheduler progress and attempt reconciliation |

One green signal cannot substitute for the others. A server can answer a health
endpoint while every real prompt is stuck. Conversely, an artifact-upload
outage should not be labeled an OpenCode product regression.

## Data Consistency

The system favors understandable at-least-once coordination over a fragile
illusion of distributed exactly-once behavior.

- Attempt IDs are allocated before work begins and are idempotency keys for
  state updates.
- The lane lease has a deadline and owner identity.
- Checkpoint writes are idempotent by `(attemptId, ordinal)`.
- Artifact descriptors are immutable after publication; a failed upload may be
  retried with the same content digest.
- Alert notifications use a deduplication key derived from policy and incident
  window.
- A reconciliation loop terminalizes abandoned attempts or marks them
  inconclusive after inspecting lane state.

Inside one Drive controller, existing Deferred and semaphore semantics continue
to provide the stronger local guarantees described by the package
architecture. The control plane does not claim exactly-once execution across a
host crash.

## Configuration Model

Every configuration that influences behavior is versioned or captured:

- OpenCode revision and build identity;
- Drive revision and package version;
- environment and lane configuration version;
- scenario ID and scenario-source revision;
- inference strategy and response-plan version;
- property seed, step budget, and generator version;
- chaos experiment specification;
- project fixture digest;
- permission and tool configuration;
- viewport and theme where UI assertions depend on them;
- protocol compatibility records.

Configuration is decoded with Effect Schema at entry boundaries. A malformed
configuration prevents lane provisioning and produces a typed configuration
failure; it never falls back silently to an undocumented default.

## Shutdown Semantics

Graceful shutdown proceeds from new work toward owned resources:

1. Mark the environment or lane as draining.
2. Stop scheduling new attempts to it.
3. Allow active attempts a bounded grace period.
4. Interrupt remaining attempts.
5. Capture cancellation evidence where safe.
6. Close attempt-owned TUIs and recordings.
7. Settle model and tool work.
8. Close the server generation and simulation connections.
9. Flush run-store and telemetry buffers.
10. Publish the final heartbeat/status and release the application scope.

Interrupts remain interrupts. Cleanup code may suppress expected cancellation
noise, but it must not record a cancelled attempt as passed.

## Design Review Checklist

Any implementation proposal should answer:

- Which plane owns this component?
- Which Effect scope owns each resource?
- What is the component's typed failure contract?
- Which failure classes are retryable?
- What identifier correlates its logs, spans, and persisted records?
- How is unknown input decoded?
- What happens if the process is interrupted between its two most important
  writes?
- How does another component notice that it stopped making progress?
- Can a retry accidentally repeat a state-changing UI action?
- Does the proposal introduce OpenCode-specific vocabulary into
  `packages/drive`?
- Does it add a backend-control CLI command or diverge from the canonical
  frontend protocol?

If those questions do not have crisp answers, the ownership boundary is not
ready.
