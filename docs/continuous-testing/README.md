# OpenCode Continuous Verification

This documentation defines a proposed always-on test environment for
OpenCode. The environment keeps real OpenCode processes running, exercises
them continuously with synthetic users, controls model output through OpenCode
Drive, checks observable invariants, and retains enough evidence to explain a
failure after the fact.

The system combines several testing disciplines:

- **Synthetic monitoring** continuously executes known user journeys against a
  running environment.
- **Canary testing** verifies one exact OpenCode revision before or while it is
  promoted.
- **Soak testing** leaves the system under realistic activity long enough to
  expose leaks, stale state, and lifecycle drift.
- **Stateful model-based property testing** generates valid action sequences
  and checks invariants after every transition.
- **Chaos testing** introduces controlled failures and verifies recovery.

The short name used throughout these documents is **continuous verification**.
It describes the product as a whole without confusing it with any one testing
technique.

## Status

This is an architecture and implementation plan. It distinguishes existing
repository behavior from proposed behavior:

- **Existing** means the capability is present in this repository now.
- **Proposed** means the capability belongs to the continuous-verification
  system but has not been implemented yet.
- **Later** means the capability is intentionally outside the first usable
  release.

No document in this directory changes the canonical OpenCode simulation
protocol. In particular, model control remains in Effect programs and scripts;
it does not become a new set of CLI commands.

## Why Build This

Unit and integration tests answer whether a known case passes in a controlled
run. They are necessary, but they do not answer several operational questions:

- Does a real OpenCode server remain useful after thousands of sessions?
- Can a TUI recover after the server disappears and returns?
- Do queued prompts, streaming output, permissions, forms, tools, and
  interruptions remain consistent under unusual interleavings?
- Did a change increase time to first output or leave more work stuck in a
  pending state?
- Can a failure be replayed with the same revision, seed, response plan, and
  action trace?
- Will somebody be notified when no test has completed successfully for ten
  minutes, even if no individual run emitted a clean failure?

Continuous verification answers those questions by treating the test system as
a continuously operated service rather than a command run occasionally by a
developer.

## Existing Foundation

The repository already contains most of the execution substrate.

| Capability | Current owner | How it is reused |
| --- | --- | --- |
| Isolated OpenCode server and project | [`packages/drive`](../../packages/drive) | One real server per test lane |
| Headless or visible TUI control | [`OpenCodeDriver`](../../packages/drive/src/driver/index.ts) | Synthetic user input and UI assertions |
| Simulated model output | [`driver/llm-controller.ts`](../../packages/drive/src/driver/llm-controller.ts) | Deterministic, reactive, and fault-injected inference |
| Runtime tool control | [`packages/drive/src/tool`](../../packages/drive/src/tool) | Delayed, failed, interrupted, and concurrent tools |
| Executable OpenCode journeys | [`apps/catalog/scenarios`](../../apps/catalog/scenarios) | High-signal synthetic monitoring flows |
| Ordered flow checkpoints | [`apps/catalog/catalog/flow.ts`](../../apps/catalog/catalog/flow.ts) | Assertion and timing boundaries |
| Revision and theme variants | [`capture-opencode-drive.ts`](../../apps/catalog/scripts/capture-opencode-drive.ts) | Baseline and candidate lane planning |
| Seeded lifecycle state machine | [`lifecycle-properties.ts`](../../packages/drive/test/manual/tui-regressions/lifecycle-properties.ts) | Stateful property campaign seed |
| Frames and recordings | [`packages/drive/src/frame`](../../packages/drive/src/frame), [`recording`](../../packages/drive/src/recording) | Failure evidence |
| Run artifact and compatibility report | [`driver/report.ts`](../../packages/drive/src/driver/report.ts) | Input to the richer attempt record |

The missing product is the control and evidence layer around these primitives:
a scheduler, persistent lanes, typed run records, telemetry export, artifact
retention, dashboards, alerts, and operational supervision.

## Target Architecture

```text
                    CONTINUOUS-VERIFICATION CONTROL PLANE

   scenario registry   scheduler   run store   artifact store   alerts
           |                |          ^              ^            ^
           |                v          |              |            |
           +-----------> attempt coordinator ----------+------------+
                                  |
                    lease + scenario + revision + seed
                                  |
          +-----------------------+-----------------------+
          |                       |                       |
          v                       v                       v
   PERSISTENT LANE A       PERSISTENT LANE B       EPHEMERAL LANE
   queued mock journeys    reactive/property       clean reproduction
   OpenCode server         OpenCode server          OpenCodeDriver.use
   fresh TUI per attempt   fresh TUI per attempt
   persistent DB/state     persistent DB/state
          |                       |
          +----------- telemetry and evidence -----------+
```

The control plane decides what should run and records what happened. A lane
owns the OpenCode processes that execute it. Keeping those responsibilities
separate is important: a broken OpenCode process must not prevent the control
plane from noticing that the lane is unhealthy.

## Core Decisions

### Use a hybrid of persistent and ephemeral execution

A persistent lane catches long-lived-state failures. An ephemeral lane gives a
clean comparison and a reliable reproduction path. A passing ephemeral run
does not erase a persistent-lane failure; it is diagnostic evidence.

### Keep one OpenCode server per lane

OpenCode Drive currently launches local child processes and loopback simulation
endpoints. The first deployment should therefore colocate one runner and one
OpenCode server on the same host or in the same container/pod. Parallelism is
achieved with more lanes, not by allowing unrelated workers to compete for one
simulation controller.

### Use a fresh TUI and session per ordinary attempt

The server and selected database persist. The client used by one synthetic
journey does not. This preserves long-lived server state while bounding UI
contamination and giving every attempt a clear lifecycle owner.

Some dedicated soak experiments deliberately reuse a session or TUI. Those
experiments must say so explicitly; reuse is not the default.

### Separate queued and served inference lanes

The LLM controller has two mutually exclusive response modes:

- queued responses are simple and deterministic for sequential journeys;
- a served handler reacts to request content and supports model-based tests or
  subagent routing.

A controller does not switch between these modes after work begins. Separate
lanes keep the behavior honest and prevent response cross-talk.

### Treat checkpoints as operational assertions

Existing catalog flows already wait for meaningful UI conditions and visit
ordered checkpoints. Continuous verification wraps those checkpoints with
timing, evidence, and run-record updates. It does not duplicate the journeys in
a second monitoring DSL.

### Retain the first failure, not the best retry

Retries may determine whether a failure is intermittent, but they never rewrite
the original attempt to success. Every retry is a new attempt linked to the
first one. This is essential for measuring reliability rather than measuring
the effectiveness of retries.

### Preserve package and application ownership

[`packages/drive`](../../packages/drive) remains a generic published package.
OpenCode-specific flow IDs, taxonomies, scenario selection, evidence review,
and continuous-verification policy remain in
[`apps/catalog`](../../apps/catalog). The package must never import the app.

Generic capabilities should move into Drive only after more than one caller
needs them and only when they do not introduce OpenCode catalog vocabulary.

## Documentation Map

1. [System model](./01-system-model.md) defines the components, lifetimes,
   failure domains, and system-wide invariants.
2. [Environments and lanes](./02-environments-and-lanes.md) defines persistent
   and ephemeral execution, isolation, revisions, concurrency, and lane health.
3. [Bot orchestration](./03-bot-orchestration.md) defines scheduling, leases,
   attempt lifecycles, timeouts, retries, and Effect service boundaries.
4. [Inference simulation](./04-inference-simulation.md) defines queued,
   reactive, fault-injected, and real-provider response strategies.
   Its companion, [Provider and package contract
   testing](./04-provider-package-contract-testing.md), defines how the actual
   V2 native routes and AI SDK packages are exercised against programmable
   transports instead of being reimplemented as mocks.
5. [Scenarios and journeys](./05-scenarios-and-journeys.md) defines how catalog
   flows become monitored journeys and how new journeys are authored.
6. [Stateful property testing](./06-stateful-property-testing.md) defines the
   model, commands, invariants, generation, replay, and shrinking strategy.
7. [Soak and chaos testing](./07-soak-and-chaos-testing.md) defines long-lived
   workloads, fault experiments, recovery invariants, and safety envelopes.
8. [Observability and evidence](./08-observability-and-evidence.md) defines run
   records, spans, logs, metrics, artifacts, SLOs, dashboards, and alerts.
   [Log files and review UI](./08-log-files-and-review-ui.md) specifies the
   append-only local JSONL/raw files and the `apps/catalog` timeline/log viewer.
9. [Deployment and operations](./09-deployment-and-operations.md) defines
   process topology, supervision, rollout, configuration, runbooks, and
   recovery.
   [Elixir control-plane option](./09-elixir-control-plane-option.md) evaluates
   a hybrid OTP/Oban/Phoenix control plane with Bun/Effect workload workers.
10. [Security and safety](./10-security-and-safety.md) defines isolation,
    credentials, permissions, egress, resource limits, retention, and cost
    controls.
11. [Implementation roadmap](./11-implementation-roadmap.md) breaks the design
    into reviewable milestones with acceptance criteria.

## Suggested Reading Paths

For a first implementation:

1. Read [System model](./01-system-model.md).
2. Read [Environments and lanes](./02-environments-and-lanes.md).
3. Implement the first milestone in
   [Implementation roadmap](./11-implementation-roadmap.md).
4. Use [Observability and evidence](./08-observability-and-evidence.md) as the
   run-record contract rather than inventing fields during implementation.

For scenario authors:

1. Read [Scenarios and journeys](./05-scenarios-and-journeys.md).
2. Read [Inference simulation](./04-inference-simulation.md).
3. Use [Stateful property testing](./06-stateful-property-testing.md) only when
   fixed journeys no longer cover the important ordering space.

For inference and provider work:

1. Read [Inference simulation](./04-inference-simulation.md) for deterministic
   end-to-end model behavior.
2. Read [Provider and package contract
   testing](./04-provider-package-contract-testing.md) for native protocol,
   transport, package, and error compatibility.
3. Treat their reports as complementary coverage, not interchangeable mocks.

For operators:

1. Read [Deployment and operations](./09-deployment-and-operations.md).
2. Read [Observability and evidence](./08-observability-and-evidence.md).
3. Read [Soak and chaos testing](./07-soak-and-chaos-testing.md).
4. Read [Security and safety](./10-security-and-safety.md).

## System-Wide Invariants

Every implementation phase preserves these rules:

1. Every attempt identifies its exact OpenCode revision, scenario, lane,
   inference strategy, and configuration version.
2. Every generated action campaign records a replayable seed and action trace.
3. Every process, TUI, simulation connection, recording, and temporary file has
   exactly one lifecycle owner.
4. Expected failures use typed error values. Defects and interrupts retain
   their distinct meanings.
5. Cancellation closes resources; it is not converted into a successful run.
6. No retry of a state-changing UI operation happens invisibly inside an
   attempt.
7. The absence of successful attempts is observable independently of ordinary
   failure reporting.
8. A failed attempt is immutable. Reproduction and retries create linked
   attempts.
9. Secrets and unredacted prompts never appear in metrics, span attributes, or
   artifact paths.
10. OpenCode-specific concepts remain in `apps/catalog`; generic lifecycle and
    simulation behavior remain in `packages/drive`.
11. CLI `--command.ui.*` names and payloads remain identical to the canonical
    frontend simulation protocol, except for Drive's documented local
    `ui.screenshot` behavior.
12. Backend model control remains in programs and scripts, never convenience
    CLI commands.

## Glossary

**Attempt**
: One execution of one scenario with one lane, revision, configuration, and
  optional seed. A retry is another attempt.

**Bot**
: A long-running scheduler participant that selects and executes journeys. A
  bot is not necessarily powered by an LLM.

**Campaign**
: A related sequence of property or chaos attempts, usually sharing a revision
  and configuration but using different seeds or faults.

**Checkpoint**
: An ordered, meaningful state reached by an executable catalog flow. In the
  continuous system it is also a timing and evidence boundary.

**Control plane**
: The scheduler, lease coordination, run store, artifact index, configuration,
  and alert evaluation that continue to observe the workload plane.

**Environment**
: A named collection of lanes testing one promotion target, such as a baseline
  and candidate OpenCode revision.

**Inference strategy**
: The mechanism that produces simulated model responses: queued, reactive,
  fault-injected, or provider-backed.

**Journey**
: A deterministic scenario that represents a user-visible workflow and its
  assertions.

**Lane**
: One lifecycle and concurrency boundary containing an OpenCode server,
  project, database policy, model controller, and runner.

**Lane generation**
: One concrete lifetime of a lane's target, server, controllers, paths, ports,
  configuration, and optional retained database.

**Model**
: In property-testing documents, the small expected-state machine maintained by
  the test. In inference documents, model means the language-model provider.
  The surrounding context disambiguates the term.

**Run**
: A human grouping of attempts, such as one scheduled journey plus its
  diagnostic reproduction. Persisted APIs use the more precise word
  `attempt`.

**Recycle**
: Drain and replace a whole lane generation after a declared trigger such as a
  target/configuration change, maximum age, failed health check, or resource
  ceiling. It is not an attempt retry and does not erase failure evidence.

**Synthetic user**
: A controlled TUI or SDK client that performs real user-visible actions
  against the test environment.

**Workload plane**
: The OpenCode server, TUI processes, tools, and simulated model exchanges being
  tested.
