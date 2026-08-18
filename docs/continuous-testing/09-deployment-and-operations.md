# Deployment and Operations

This document defines how continuous verification runs as a 24/7 service. The
first deployment favors a simple, inspectable topology over a large distributed
platform. It can scale later without changing attempt, lane, and evidence
contracts.

## Operational Goals

- useful smoke work completes continuously;
- a failed or hung OpenCode process cannot hide from supervision;
- every process and resource has one owner;
- target revisions and configurations are immutable within a lane generation;
- deployments and lane recycling do not erase unresolved failures;
- the system can be drained, upgraded, and restored predictably;
- real-provider credentials and network policy remain isolated from normal
  deterministic lanes;
- operators have concrete runbooks rather than needing to understand all source
  code during an incident.

## Recommended First Topology

Run one control-plane process and a small number of colocated lane workers on a
dedicated host or container runtime.

```text
host / node
  control plane
    scheduler
    reconciler
    freshness evaluator
    run-record writer
    artifact uploader

  lane queued-1
    lane worker
    OpenCode server
    fresh TUI per attempt
    Drive backend/frontend controllers
    isolated project + data directories

  lane reactive-1
    same process family, separate ports/state

  ephemeral worker pool
    finite OpenCodeDriver.use runs
    provider contract processes
    replay/shrink jobs
```

The control plane and lane workers may initially be one deployable application
with separate supervised processes. They remain logical services with separate
health and failure domains.

## Why Colocate a Lane

OpenCode Drive currently manages local child processes, loopback endpoints,
terminal clients, artifact directories, and simulation connections. Keeping one
lane's worker, server, controllers, and TUI on the same node avoids premature
remote-control protocol design.

Scale by adding lane units. Do not let unrelated workers attach to one backend
controller or share one ordinal LLM response queue.

## Process Tree

Every lane generation records and owns an explicit process tree:

```text
lane supervisor
  lane worker
    opencode server
    opencode TUI A
    optional TUI B for declared scenario
    renderer/terminal children owned by TUI
```

The supervisor records PID plus a stronger generation identity such as process
start time and lane token. A recycled PID must not be mistaken for the old
process.

All subprocesses receive:

- lane and generation correlation;
- explicit isolated data/config/cache paths;
- loopback port allocation;
- target revision/binary path;
- bounded environment allowlist;
- output redirection with rotation;
- shutdown deadline.

## Supervisor Responsibilities

The supervisor:

- starts control-plane and lane processes;
- restarts only according to component policy;
- records crash loops and exit reasons;
- enforces resource limits;
- delivers termination then bounded force-kill to explicit children;
- starts no new work during drain;
- verifies that stopped generations release ports and processes;
- remains independent of OpenCode health.

Use the platform supervisor available in the chosen environment:

- systemd or launchd for a dedicated host;
- Kubernetes Deployments/StatefulSets or Jobs for a cluster;
- a container runtime restart policy plus an external freshness evaluator;
- a process supervisor for local development only.

An application-level Effect supervisor coordinates fibers and attempts, but it
does not replace an operating-system-level process supervisor.

## Service Boundaries

Suggested Effect services:

- `WorkQueue` stores and leases work;
- `Scheduler` creates cadence and revision-triggered work;
- `LaneRegistry` tracks generations, capabilities, health, and leases;
- `LaneRuntime` owns one process/state topology;
- `AttemptCoordinator` runs one bounded attempt;
- `RunStore` writes durable work and attempt records;
- `ArtifactStore` publishes verified evidence;
- `TargetResolver` resolves immutable OpenCode/Drive artifacts;
- `HealthEvaluator` computes lane readiness and freshness;
- `AlertSink` delivers notifications;
- `Clock` and configuration services support deterministic tests.

Construct live layers once at the process edge. Each lane generation and attempt
runs in a child scope with finalizers.

## Storage Layout

Use separate declared roots. Example conceptual layout:

```text
state/
  control/
    queue.db
    run-buffer/
  lanes/
    <lane-id>/
      generations/<generation-id>/
        opencode-data/
        project/
        logs/
        runtime/
      retained-failures/
  artifacts-staging/
  target-cache/
```

The actual paths are deployment configuration. No cleanup command derives a
recursive target from an unset variable, home directory, workspace root, or
glob.

Separate:

- control-plane durable state;
- lane-persistent OpenCode state;
- per-attempt temporary state;
- artifact staging;
- immutable target cache.

## Databases

The run store may begin with SQLite on one host if:

- one process owns writes or locking is well understood;
- backups and integrity checks are configured;
- the control plane can recover non-terminal attempts after restart;
- artifacts remain outside database blobs;
- migration version is recorded and tested.

Move to a network database when multiple control-plane replicas or nodes need
concurrent leases. Do not introduce it only to appear production-like.

Each persistent lane has its own OpenCode database or explicitly isolated
database namespace. A shared database across lanes would make state attribution
and chaos safety much harder.

## Artifact Storage

Use local staging plus an object store or durable filesystem.

Upload sequence:

1. write artifact to attempt-owned staging path;
2. close and compute digest;
3. redact/validate according to artifact kind;
4. write immutable destination object;
5. verify digest/size;
6. create artifact record;
7. delete staging copy after policy permits.

If the central store is unavailable, preserve the manifest and essential
artifacts locally within a quota. Stop expensive campaigns before overwriting
unuploaded failure evidence.

## Port Allocation

Every lane owns an explicit port lease covering:

- OpenCode server/API;
- frontend simulation endpoint;
- backend inference/tool simulation endpoint;
- any preview or fixture service declared by the scenario.

Allocate from a configured loopback range or let the runtime assign available
ports and persist the resolved values. Validate ownership before launch. Release
only after the process generation stops.

A port in use by an unknown process marks the lane unhealthy; never terminate
the unknown process automatically.

## Target Artifacts

Do not mutate a checked-out target under a running lane. Resolve one immutable
artifact per revision:

- clean Git worktree pinned to commit;
- built package/binary digest;
- container image digest;
- or a development command plus exact checkout commit for local-only use.

Attempt records include both requested revision and resolved commit/artifact
digest.

For `../opencode:v2`, the resolver fetches or observes the ref, resolves it to a
commit, and builds a new target artifact. Existing lane generations continue on
their pinned artifact until drained.

## Configuration

Configuration is schema-validated at startup and versioned by digest.

Groups:

- run-store and artifact endpoints;
- target repository/ref/build command;
- lane definitions and capacities;
- scheduler cadences and priorities;
- scenario/campaign policy;
- timeouts and retry schedules;
- resource and retention quotas;
- telemetry exporters;
- alert routing;
- network/credential profiles;
- maintenance and rollout policy.

Reject unknown fields for safety-critical configuration. Secrets are references
to a secret provider, not values serialized into the configuration snapshot.

Config reload policy:

- scheduling/alert thresholds may update atomically when supported;
- lane topology, target, network, or credential profile changes create a new
  lane generation;
- an active attempt keeps the configuration digest with which it started;
- invalid reload leaves the previous valid configuration active and alerts.

## Deployment Profiles

### Local development

- one ephemeral worker;
- optional one persistent lane;
- local SQLite and artifact directory;
- no real-provider credentials by default;
- visible TUI optional;
- manual dashboard or CLI status.

### Dedicated single host

- one control plane;
- two or more deterministic lanes;
- OS supervisor;
- local run database with backups;
- remote artifact/telemetry destination;
- container or OS-level resource limits;
- independent external freshness check.

This is the recommended first 24/7 production-like deployment.

### Cluster

- replicated/stateless schedulers with leader or idempotent scheduling;
- network work/run store;
- one pod/unit per persistent lane;
- Jobs for ephemeral attempts;
- object artifact store;
- node pools separated by credential/network profile;
- pod disruption and rollout controls.

Adopt only when capacity, isolation, or availability needs justify it.

## Lane Bootstrap

One generation boot sequence:

1. acquire lane-generation record;
2. resolve and verify target artifact;
3. prepare isolated paths and ports;
4. write configuration and fixture;
5. launch OpenCode server in simulation mode;
6. attach Drive controllers;
7. launch a fresh TUI;
8. verify handshakes and declared capabilities;
9. run bootstrap smoke;
10. publish `ready` only after smoke passes;
11. close bootstrap TUI and admit normal work.

Process liveness alone never makes a lane ready.

## Lane Health

Health has separate dimensions:

```text
processHealth
protocolHealth
controlHealth
workFreshness
resourceHealth
evidenceHealth
```

Lane states:

- `starting`;
- `ready`;
- `leased`;
- `draining`;
- `experimenting`;
- `degraded`;
- `frozen`;
- `recycling`;
- `stopped`.

A lane may have live processes but be `degraded` because its controller is
detached or no work has completed recently.

## Heartbeats

The control plane writes a heartbeat independent of scheduled work. Each lane
worker writes:

- generation;
- state;
- active attempt if any;
- process health summary;
- last successful control probe;
- last attempt completion;
- resource summary;
- timestamp and monotonic sequence.

An external evaluator checks both. Heartbeats are leases with expiry, not
unbounded rows.

## Scheduling

Use a durable work queue for at-least-once delivery and attempt idempotency.

Scheduler inputs:

- fixed cadence;
- target revision change;
- package/lockfile impact;
- replay/shrink request;
- alert-triggered diagnostics;
- maintenance windows;
- live-provider budget windows.

Avoid synchronized bursts by applying controlled schedule jitter. Priority and
backpressure rules are defined in [Bot orchestration](./03-bot-orchestration.md).

## Rollout of a New OpenCode Revision

Use generation replacement:

1. resolve candidate ref to immutable commit;
2. build and verify artifact;
3. create candidate lanes without touching baseline lanes;
4. run protocol handshake and bootstrap suite;
5. run essential deterministic journeys;
6. run impacted provider/package contracts;
7. start candidate soak while baseline remains available;
8. promote candidate as active target after gate policy;
9. drain old lanes;
10. retain old artifact until failure/reproduction policy permits deletion.

A broken candidate cannot prevent baseline health signals.

## Drive and Catalog Rollout

Drive, catalog scenarios, and control-plane code also have revisions. Treat a
harness rollout as a canary:

- run old and new harness against the same known target where possible;
- compare attempt outcomes and protocol compatibility;
- validate scenario-definition and response-plan digests;
- verify evidence and redaction;
- move a subset of lanes first;
- retain the previous deployable artifact for rollback.

A harness rollout that changes many failures should initially classify them as
potential harness drift until compared against the old runner.

## Protocol Compatibility

On lane bootstrap, record:

- frontend and backend handshake profiles;
- OpenCode server name/version;
- protocol capability set;
- Drive compatibility policy and result;
- unsupported optional capabilities;
- exact copied protocol schema version/digest when available.

CLI `--command.ui.*` names and payloads stay identical to the canonical OpenCode
frontend protocol. Backend model control remains in scripts and Effect programs.

If a canonical protocol change is required, update OpenCode first, copy it into
Drive, update the CLI directly, and run both repositories' protocol tests. Do
not add aliases to smooth over incompatible versions.

## Draining

Drain sequence:

1. mark component/lane `draining` and stop new leases;
2. wait for active attempt to reach a safe boundary up to a deadline;
3. interrupt according to attempt type and record cancellation;
4. collect required evidence and terminalize/reconcile;
5. settle Drive responses/tools;
6. close TUI clients;
7. stop server/controllers;
8. verify process/port release;
9. close scopes and storage handles;
10. mark stopped.

System shutdown is not a successful attempt outcome.

## Restart Policy

### Control plane

Restart automatically on unexpected exit, then reconcile leases and attempts.
Crash loops alert and stop repeated rapid restart according to supervisor
policy.

### Lane worker

Restart may create a new lane generation. Do not adopt the old process tree by
guessing. First inspect explicit runtime metadata and kill only verified
lane-owned remnants.

### OpenCode server

Ordinary unexpected exit fails the active attempt and freezes or recycles the
lane according to evidence policy. A chaos experiment may expect supervision to
restart it while preserving experiment correlation.

### TUI

An unexpected exit fails that attempt. Start a new TUI for the next attempt only
after cleanup; do not retry the same state-changing UI action invisibly.

## Reconciliation After Control-Plane Restart

On startup:

1. load non-terminal work, attempts, and lane generations;
2. expire stale leases using persisted expiry and current time;
3. query lane heartbeats/process identity;
4. ask live workers for active attempt where protocol supports it;
5. terminalize orphan attempts as interrupted/infrastructure or leave them
   pending only under a bounded recovery rule;
6. requeue work as a new linked attempt when policy permits;
7. detect duplicate generation ownership and quarantine affected lanes;
8. resume schedules from durable last-enqueue markers.

At-least-once work delivery does not imply exactly-once UI side effects.
Attempt IDs and append-before-execute records prevent silent duplication.

## Backups and Restore

Back up:

- run/queue database;
- configuration history;
- artifact manifests and object-store durability metadata;
- approved provider cassettes through source control;
- optional retained persistent-lane snapshots for unresolved failures.

Do not treat ordinary lane state as the only copy of critical evidence.

Restore drills verify:

- database integrity and migrations;
- work/attempt reconciliation;
- artifact link/digest validity;
- scheduler does not enqueue an uncontrolled backlog;
- secrets are re-resolved, not restored from plaintext backup;
- a bootstrap smoke completes after restore.

## Capacity Planning

Measure per lane:

- CPU/RSS at idle and under each workload profile;
- process and handle count;
- database and artifact growth;
- attempts/hour;
- median and tail scenario duration;
- property shrink concurrency;
- provider-contract parallelism;
- build/target cache size.

Reserve capacity for:

- one baseline lane during candidate rollout;
- one frozen failure without immediate deletion;
- an ephemeral replay/shrink worker;
- telemetry/artifact buffering during transient outages.

Admission control rejects or delays work before host pressure destabilizes all
lanes.

## Cost Controls

Deterministic simulation cost is host/storage. Real-provider lanes add monetary
cost.

- per-call token/output limits;
- per-attempt and daily budgets;
- provider/model allowlist;
- concurrency cap;
- circuit breaker after repeated provider failures;
- global kill switch independent of deployment;
- cost estimates in attempt records;
- alerts before hard budget exhaustion;
- no fallback to a more expensive provider unless the experiment explicitly
  tests it.

## Maintenance

Scheduled tasks:

- lane recycle by age;
- database integrity and backup;
- artifact retention and staging cleanup;
- target/build cache pruning;
- provider cassette age report;
- coverage manifest refresh;
- dependency and base-image updates;
- restore drill;
- security credential rotation;
- alert-route test.

Maintenance creates run records or audit events. It does not silently suppress
freshness alerts; declared maintenance windows are visible to alert evaluation.

## Operator Commands

The control plane may expose operational commands such as:

- list lane health;
- drain/freeze/recycle one lane;
- enqueue a registered scenario/campaign;
- replay an attempt;
- acknowledge/classify a failure;
- enable/disable a scheduler policy;
- activate real-provider global kill switch;
- inspect artifact manifest;
- show exact target/configuration.

These are control-plane operations, not additions to OpenCode's simulation
frontend CLI. They operate on stable IDs, require authorization, and write an
audit record.

## Runbooks

### No successful smoke

1. Check independent control-plane and lane heartbeat age.
2. Inspect queue age and active leases.
3. Determine whether all lanes share target/config/harness revision.
4. Run one ephemeral bootstrap smoke on the last known-good target.
5. Freeze the first relevant failure evidence.
6. Roll back harness/config only with evidence that it caused the outage.
7. Restore at least one known-good deterministic lane.

### Lane heartbeat stale

1. Verify supervisor/process state from outside the worker.
2. Check host resource and disk state.
3. Avoid killing by process name; resolve recorded generation identity.
4. Preserve logs/runtime metadata.
5. mark active attempt interrupted through reconciliation;
6. start a new generation and bootstrap smoke.

### Lane alive but work hung

1. Inspect active attempt phase and deadline.
2. Check LLM/tool pending summaries and controller attachment.
3. Collect current frame/session/process evidence.
4. Let configured attempt timeout/interrupt execute.
5. Freeze if cleanup does not settle.
6. reproduce ephemerally before recycle where possible.

### Artifact store unavailable

1. Stop visual/property/soak campaigns that produce large evidence.
2. Continue essential smoke metadata only if the durable local buffer is safe.
3. Monitor local quota.
4. Restore store and upload digest-verified backlog.
5. alert on any evidence degradation or discarded sampled success artifact.

### Candidate regression

1. Keep baseline lanes active.
2. compare exact scenario/config/response-plan inputs;
3. run ephemeral replay on baseline and candidate;
4. run impacted package contracts when inference-related;
5. block promotion, not the baseline service;
6. link minimized evidence to the source change.

## Disaster and Safety Conditions

Immediately stop admission when:

- filesystem target validation fails;
- unknown processes occupy lane ports or paths;
- deterministic lane attempts real network egress;
- secret/redaction policy fails broadly;
- run database cannot durably terminalize attempts and local fallback is full;
- host resource limits threaten the control plane;
- duplicated lane-generation ownership is detected.

Prefer a visible outage over unsafe untracked work.

## Acceptance Criteria

The deployment is ready for unattended 24/7 operation when:

- control-plane and lane processes are supervised outside OpenCode;
- every lane generation owns explicit processes, paths, ports, target, and
  configuration;
- bootstrap smoke, not process liveness, gates readiness;
- stale heartbeat and stale successful-work alerts are externally evaluated;
- non-terminal attempts reconcile after control-plane restart;
- rollout creates new immutable target generations and preserves baseline;
- drain and recycle verify all child processes, ports, and scoped resources are
  released;
- failed lanes preserve evidence before recycle;
- storage, artifact, target-cache, resource, and provider-cost quotas are
  enforced;
- backup restore and alert routing are tested;
- operational commands are audited and do not modify the canonical simulation
  CLI protocol;
- at least one last-known-good deterministic lane can be restored without
  depending on the failing candidate.

