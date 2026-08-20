# Elixir Control-Plane Option

This document evaluates using Elixir/OTP for the 24/7 control plane while
keeping OpenCode Drive and provider-contract execution in TypeScript/Effect.

## Recommendation

Elixir is a good fit for the **outer operational service**. It is not a good
replacement for the inference simulator, provider-package harness, canonical
OpenCode protocol client, or catalog scenarios.

The only Elixir architecture recommended here is therefore a hybrid:

```text
Elixir/OTP control plane
  scheduling, durable jobs, supervision, heartbeats, API, alerts
                    |
           versioned worker contract
                    |
Bun/TypeScript workload workers
  Drive, OpenCode protocol, scenarios, provider packages, Effect scopes
                    |
                    v
        OpenCode server/TUI/provider transports
```

Do not rewrite `packages/drive` or `../opencode/packages/ai` in Elixir. That
would duplicate the exact TypeScript contracts we need to test.

Between Erlang and Elixir, choose Elixir unless the team already operates an
Erlang codebase. Both use BEAM/OTP; Elixir offers a more approachable language,
Mix, Ecto, Phoenix, and the surrounding application tooling needed here.

## What Elixir Would Buy Us

### Explicit supervision trees

OTP supervisors define child start, shutdown, restart, and restart-intensity
policy. A `DynamicSupervisor` can own the dynamically changing set of lane
coordinators, while ordinary supervisors own durable services such as the
scheduler, log ingestor, and alert evaluator. See the official
[`Supervisor`](https://hexdocs.pm/elixir/Supervisor.html) and
[`DynamicSupervisor`](https://hexdocs.pm/elixir/DynamicSupervisor.html)
documentation.

### Cheap isolated coordinators

One BEAM process can represent each:

- lane generation;
- active attempt;
- live log subscription;
- heartbeat evaluator;
- provider-bot status aggregator.

Those processes isolate control-plane failures and communicate through
messages. Durable truth still belongs in the database.

### Mature durable scheduling

Oban can provide database-backed scheduled work, queues, priorities, retryable
jobs, cancellation, and periodic insertion. Its queue concurrency is useful for
separating smoke, provider-contract, replay, property, and live-provider work.
See the official [Oban](https://hexdocs.pm/oban/Oban.html) and [queue
documentation](https://hexdocs.pm/oban/defining_queues.html).

Oban uniqueness is insertion-time deduplication, not a guarantee that matching
jobs never execute concurrently. The verification design still needs attempt
IDs, lane leases, idempotent reconciliation, and explicit concurrency policy;
see Oban's [unique jobs
documentation](https://hexdocs.pm/oban/unique_jobs.html).

### Operational web/API layer

Phoenix can expose the fleet, attempt, artifact, and live-log APIs. Phoenix
LiveView could implement a real-time viewer, but the recommended initial design
keeps the existing React review UI in `apps/catalog` and feeds it from the
Elixir API/SSE or WebSocket endpoint. This preserves current UI ownership and
avoids rewriting the catalog. LiveView remains a reasonable later option; its
process-and-diff model is described in the official [LiveView
documentation](https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.html).

## What Elixir Would Not Solve

Elixir does not automatically solve:

- provider behavior and error compatibility;
- OpenAI/Anthropic/Gemini/Bedrock framing;
- TypeScript package loading;
- Drive's queue-versus-serve inference semantics;
- OpenCode session assertions;
- OS process-tree containment;
- exactly-once UI actions;
- artifact redaction;
- useful-work freshness.

Those remain explicit application contracts.

Most workload processes are external Bun/OpenCode programs. OTP can supervise a
port owner, but an external process is not a BEAM process. Official Elixir
documentation warns that closing a port or crashing the VM does not necessarily
terminate a long-running external OS process. Use a container, process group,
or platform supervisor and verify descendants during cleanup; see
[`Port`](https://hexdocs.pm/elixir/Port.html) and
[`System.cmd/3`](https://hexdocs.pm/elixir/System.html#cmd/3).

## Recommended Ownership Split

### Elixir control plane owns

- bot registry and enable/quarantine state;
- periodic scheduling and work insertion;
- durable job/attempt state;
- lane leases and generation registry;
- `DynamicSupervisor` for lane coordinator processes;
- worker process launch/monitoring;
- heartbeat and useful-work freshness;
- log-file indexing and live-tail fan-out;
- artifact metadata and retention jobs;
- alert evaluation and delivery;
- operator API and audit log;
- provider credential/network profile selection;
- global live-provider and chaos kill switches.

### TypeScript/Effect worker owns

- `OpenCodeDriver` and simulation connections;
- exact canonical `ui.*` protocol usage;
- queued/served inference handlers;
- controlled tool behavior;
- executable catalog scenarios and checkpoint assertions;
- V2 provider/package contract execution;
- programmable HTTP/WebSocket transport scripts;
- property model commands that directly use Drive/OpenCode types;
- frame, recording, and attempt-local artifact production;
- scoped cleanup of every resource it opens;
- a typed terminal result for the control plane.

### `../opencode` owns

- native provider routes and errors;
- actual AI SDK fallback behavior;
- provider-contract tests and fingerprints;
- canonical simulation behavior and protocol.

## Suggested OTP Tree

```text
Verification.Application
  Verification.Repo
  Oban
  Verification.RunStore
  Verification.BotRegistry
  Verification.Scheduler
  Verification.FreshnessEvaluator
  Verification.ArtifactStore
  Verification.LogIndex
  Verification.Alerting
  Verification.LaneSupervisor            DynamicSupervisor
    Verification.Lane                    one per active lane generation
      Bun lane worker / OpenCode tree     external, explicitly contained
  Verification.WorkerSupervisor          Task/Dynamic supervisor as needed
  VerificationWeb.Endpoint
```

Do not put one permanent BEAM process under the tree for every logical provider
bot. Provider bots are durable definitions and jobs. A bounded worker queue
executes them. A process may temporarily represent an active bot attempt.

## Lane Process

One `Verification.Lane` process tracks only control state:

```text
lane ID and generation
target/config digests
worker process identity
ports/paths/container identity
state: starting | ready | leased | draining | frozen | recycling
active attempt
last heartbeat and useful completion
resource summary
```

It does not hold the only copy of durable attempt or lane state. On restart it
reconstructs from the database and revalidates the external worker identity.

The lane process serializes commands such as:

- bootstrap;
- lease attempt;
- drain;
- collect/freeze evidence;
- recycle;
- stop.

## Meaning of Recycle in OTP

Recycling a lane maps naturally to supervised replacement, but it is not simply
“let the process crash and restart.”

The coordinator first:

1. marks the generation draining;
2. stops new work;
3. terminalizes or interrupts the active attempt;
4. asks the Bun worker to settle and collect evidence;
5. terminates the explicit external process/container tree;
6. verifies ports and paths are released;
7. persists the old generation terminal state;
8. starts a new generation child;
9. waits for bootstrap smoke before marking it ready.

An unexpected crash follows a related recovery path, but remains recorded as a
crash rather than a planned recycle.

## Worker Contract

The hybrid succeeds only if the cross-language boundary is small and versioned.

### Job input

```text
WorkerJob
  protocolVersion
  attemptId
  kind
  exact target/harness revisions
  config/fixture/plan digests and references
  scenario/campaign/provider contract identity
  deadline and budgets
  artifact root
  restricted correlation token
```

### Worker events

```text
WorkerEvent
  protocolVersion
  source sequence
  attempt/lane generation identity
  timestamp and elapsed time
  event type
  phase/checkpoint
  safe fields
```

### Terminal result

```text
WorkerResult
  protocolVersion
  attemptId
  outcome
  typed failure summary
  output-started state
  checkpoint summary
  artifact/log manifests
  compatibility/fingerprint result
  cleanup result
```

Use JSON-compatible values with a published schema and compatibility tests in
both languages. Do not expose Effect types, Elixir structs, closures, or stack
objects across the boundary.

## Transport Between Elixir and Bun

### Finite jobs

The simplest reliable first contract is file plus process exit:

1. Elixir writes immutable job JSON;
2. Elixir starts a Bun worker with explicit arguments, environment, workdir,
   process containment, and result/log paths;
3. the worker writes structured JSONL and raw logs to attempt-owned files;
4. the worker atomically writes a terminal result;
5. Elixir monitors exit, validates the result, and reconciles missing results.

This avoids treating arbitrary stdout from dependencies as a control protocol.

### Persistent lanes

After the finite contract is stable, use a loopback Unix socket or authenticated
loopback endpoint for commands, heartbeats, and live events. Keep files as the
durable fallback.

Do not invent another version of OpenCode's simulation protocol. This is a
control-plane-to-worker contract above Drive.

## Logs and Viewer

The TypeScript worker remains the authoritative producer of attempt-local JSONL
and raw process logs because it owns the processes and semantic events.

Elixir:

- tails/indexes structured files by sequence;
- stores searchable safe rows;
- publishes live updates through Phoenix;
- detects gaps, truncation, and stale writers;
- retains manifests and artifact metadata;
- applies access policy.

The existing React `apps/catalog` viewer consumes:

- fleet/bot status API;
- attempt list/detail API;
- paginated log/timeline API;
- live SSE/WebSocket updates;
- authorized artifact URLs.

This gives the operational benefit of Phoenix without discarding the existing
catalog UI.

## Provider Bots in Elixir

One logical provider bot becomes a durable bot-definition row plus scheduled
Oban jobs.

Example:

```text
provider.anthropic.messages.native
  cadence: hourly deterministic, daily recording-age check
  queue: provider_contract
  concurrency key: target + contract ID
  worker job: run target provider-contract report case set
  freshness: last deterministic success < 2 hours
```

The Oban worker does not reimplement Anthropic. It launches the TypeScript
contract worker in `../opencode`, validates its terminal report, and updates bot
health.

Provider credentials are supplied only to separate live-probe jobs and never to
deterministic contract jobs.

## Error and Retry Boundaries

Keep two retry systems from fighting each other:

- OpenCode owns provider/session retry semantics under test;
- the TypeScript attempt worker records those behaviors but does not hide them;
- Oban may retry safe infrastructure preparation or an unstarted job;
- once a state-changing attempt starts, an Oban retry creates a new linked
  attempt rather than reusing the identity;
- Elixir never interprets a worker process crash as success;
- a missing terminal result enters reconciliation.

Configure Oban retries conservatively. The durable attempt record, not Oban's
job state alone, is the test result.

## Effect Boundary

Inside the Bun worker, keep the existing Effect design:

- services for Drive, target, attempt logging, artifact writing, and contract
  execution;
- live/test implementations supplied through layers at the worker entrypoint;
- one scoped attempt lifecycle;
- typed errors distinct from defects and interruption;
- `Schedule` only for declared polling/retry behavior inside that boundary;
- OpenTelemetry/log context derived from the Elixir-provided attempt identity.

Elixir does not replace those guarantees; it supervises the worker runtime from
outside it.

## Costs

The hybrid adds:

- a second language and build/deployment toolchain;
- a versioned cross-language protocol;
- likely Postgres/Ecto if using Oban conventionally;
- duplicate schema validation implementations or generated schemas;
- more integration and local setup;
- harder debugging when ownership is unclear;
- a need for maintainers comfortable with OTP.

It is a poor choice if nobody intends to maintain Elixir or if the project will
remain a small local test script.

## Comparison

| Design | Advantages | Costs | Recommendation |
| --- | --- | --- | --- |
| TypeScript/Effect only | One language, direct Drive imports, fastest first attempt | More application-owned supervision/job durability | Best default MVP |
| Elixir control plane + TS workers | OTP supervision, durable scheduling ecosystem, strong operational API | Two runtimes and a real protocol boundary | Best long-term option if team knows/wants Elixir |
| Rewrite Drive/provider logic in Elixir | One control-plane language in theory | Duplicates TS contracts and no longer tests actual packages | Do not do |
| Raw Erlang control plane | Same OTP strengths | Less ergonomic application/UI ecosystem for this team/repo | Use only with existing Erlang expertise |

## Decision Spike

Before committing the full architecture, build one narrow vertical slice:

1. an Elixir application with a supervisor, database, and one durable job;
2. one Bun `verify-once` worker running the deterministic smoke scenario;
3. versioned job/event/result JSON schemas;
4. JSONL tail/index into one attempt page in the existing catalog UI;
5. kill the Bun worker, Elixir lane process, and Elixir app at different phases;
6. prove reconciliation and external-process cleanup;
7. measure local setup and debugging cost.

Decision gate:

- choose the hybrid if recovery is materially simpler, the boundary stays
  small, and at least one maintainer is comfortable owning it;
- remain TypeScript/Effect-only if the cross-language overhead dominates or the
  team would depend on one Elixir specialist.

## Acceptance Criteria for the Hybrid

- Elixir never imports or reimplements Drive/OpenCode provider semantics;
- TypeScript workers can run independently from a job file for local replay;
- every cross-language value is schema-versioned and validated on both sides;
- durable attempt state survives either runtime restarting;
- external OpenCode/Bun process trees cannot become orphans silently;
- Oban retry cannot duplicate a state-changing attempt under the same attempt
  identity;
- provider bots remain logical definitions rather than permanent processes;
- `apps/catalog` continues to own the OpenCode-specific review UI;
- JSONL/raw logs remain usable when Phoenix or the database is unavailable;
- an Effect-only deployment remains possible until the Elixir spike proves its
  value.

