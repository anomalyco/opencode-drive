# Soak and Chaos Testing

This document defines long-running workload tests and controlled failure
experiments for the always-on OpenCode environment.

Soak testing and chaos testing share infrastructure, but they answer different
questions:

- **Soak testing** asks whether normal use remains healthy after hours, days,
  and accumulated state.
- **Chaos testing** asks whether the system preserves declared safety and
  recovery properties when one known fault occurs at a known lifecycle phase.

Neither technique means “run random destructive commands against a machine.”

## Objectives

The combined program should reveal:

- memory, handle, file descriptor, process, and storage growth;
- performance degradation with session/history/database age;
- stale client, simulation controller, and server state;
- failure to release requests, tools, forms, permissions, or execution claims;
- restart and reconnection defects;
- incorrect retry or continuation after partial provider output;
- data loss or duplication across interruption boundaries;
- correlated failures that ordinary isolated tests never encounter;
- an environment that is alive but no longer completing useful work.

## Principles

### State the hypothesis first

Every experiment declares the failure being injected and the property expected
to survive. “Kill things and see what happens” produces ambiguous evidence and
unsafe automation.

### One primary fault per experiment

Start with one controlled fault. Combining faults is valuable later, after each
component failure is understood independently.

### Preserve the first unexpected state

Do not immediately restart and erase evidence. Freeze the affected lane, collect
bounded artifacts, then reproduce in an ephemeral environment.

### Bound the blast radius

Every fault has an explicit target, duration, budget, and cleanup check. The
injection mechanism must be incapable of selecting the host, workspace root,
unrelated container, or real user process by an unresolved glob or broad
environment variable.

### Keep control plane independent

The scheduler, heartbeat evaluator, artifact writer, and alert path must not run
inside the only OpenCode process they monitor. A killed server must remain
observable.

## Soak Workload Model

A soak is not one huge scenario. It is a sequence of bounded attempts against a
persistent lane, with periodic health samples and explicit lane-age evidence.

```text
lane starts
   |
   +--> attempt 1 --> health sample
   +--> attempt 2 --> health sample
   +--> ...
   +--> maintenance checkpoint
   +--> ...
   +--> declared recycle or failure freeze
```

Each attempt remains independently attributable and replayable. The lane adds
accumulated context:

- server generation and start time;
- database age and size;
- session/message counts;
- total prompts and model steps;
- cumulative tool invocations;
- TUI/controller reconnect counts;
- prior successful and failed attempts;
- host/process resource samples.

## Workload Profiles

### Baseline conversation soak

- fresh TUI and session per attempt;
- short deterministic text response;
- occasional reasoning and multiple chunks;
- normal completion only;
- high frequency and low artifact volume.

This profile establishes the lowest-noise trend for resource leaks and latency
drift.

### Tool lifecycle soak

- controlled read, edit, search, question, and shell-like fixture tools;
- bounded success, declared failure, and progress updates;
- permission policy varied by scenario;
- fixture reset between attempts;
- exact tool settlement assertions.

### Session-history soak

- selected sessions deliberately reused;
- history grows across a declared number of steps;
- compaction and context limits exercised;
- reopen from fresh TUI clients;
- response and projection latency measured against history size.

### Multi-session soak

- several sessions progress concurrently through a request-aware served model;
- sessions use distinct markers and tool calls;
- assertions check routing and isolation;
- concurrency remains below a declared lane capacity.

### Client reconnect soak

- server stays persistent;
- fresh TUIs connect and disconnect repeatedly;
- selected attempts keep one TUI across a server generation change;
- stale subscriptions, duplicated events, and retained terminal instances are
  monitored.

### Mixed realistic soak

Use only after individual profiles are stable. A weighted schedule combines
ordinary conversations, tools, navigation, interruptions, and bounded restarts.
It is useful for discovery but weaker for diagnosis, so failures trigger replay
through the narrowest matching profile.

## Soak Durations

Use progressive qualification:

| Stage | Typical duration | Purpose |
| --- | --- | --- |
| Local qualification | 15–30 minutes | Find immediate lifecycle leaks and harness errors |
| Pull-request extended | 1–2 hours, selected changes | Catch short accumulation regressions |
| Nightly | 6–12 hours | Cross multiple maintenance and workload cycles |
| Continuous | Repeated bounded attempts until a declared lane-replacement trigger | Detect long-age drift and rare interleavings |
| Release qualification | 24–72 hours | Compare candidate against a stable baseline |

Duration is configuration, not the success condition. A soak succeeds only if
all attempt and trend invariants pass and the final lane cleanup/recycle is
healthy.

## Resource Sampling

Sample at a fixed low cadence and around attempt boundaries:

- resident and virtual memory;
- CPU time and recent utilization;
- open file descriptors or handles;
- child process count;
- thread count where meaningful;
- event-loop delay if available;
- database bytes, WAL bytes, and row counts;
- artifact/log disk bytes;
- active sessions, executions, requests, tools, and clients;
- connection/reconnect counts;
- attempt and checkpoint latency distributions.

Record raw samples in bounded artifacts or a time-series backend. Metrics use
lane and revision dimensions, not process IDs or session IDs as labels.

## Leak Detection

A single high value is not necessarily a leak. Evaluate:

- absolute safety ceiling;
- baseline-adjusted slope over a minimum window;
- post-attempt return toward a steady band;
- step changes correlated with one scenario;
- monotonic growth in a resource that should be bounded;
- comparison with an idle control lane;
- candidate versus baseline revision under matched workload.

Example policy:

```text
suspect memory leak when all hold:
  lane age >= 2 hours
  completed attempts >= 200
  robust RSS slope > configured bytes/attempt
  RSS does not return within steady-state band after cooldown
  candidate slope materially exceeds baseline slope
```

Thresholds are initially observational. Promote them to gates only after enough
healthy history establishes variance.

## Lane Maintenance and Recycling

Continuous does not mean immortal. Lanes need declared lifecycle policy.

Here, recycling means replacing the entire lane generation—server,
controllers, attempt-owned clients, and optionally its retained database—not
merely clearing a session. A continuous soak may keep a lane for days when lane
age is the thing being tested, while ordinary smoke lanes may use a shorter
scheduled maximum age. Both also recycle on revision/configuration changes or
unhealthy state.

Recycle reasons:

- scheduled maximum age;
- tested revision changed;
- configuration or protocol version changed;
- resource ceiling approached;
- maintenance window;
- lane frozen after a failure and evidence completed;
- unrecoverable health state.

Every recycle records a reason and performs:

1. stop admitting work;
2. allow or interrupt the active attempt according to deadline;
3. capture final health/resource state;
4. settle controllers and clients;
5. terminate lane-owned processes;
6. verify no process or port remains;
7. archive or delete state according to policy;
8. start a new generation and run a bootstrap smoke.

An unexpected crash is not mislabeled as a scheduled recycle.

## Chaos Experiment Model

Every chaos experiment has a versioned specification:

```text
ChaosExperiment
  id
  hypothesis
  eligible lane kind
  steady-state probe
  trigger phase
  fault
  target resolver
  duration/budget
  expected transient observations
  recovery action, if any
  recovery invariants
  abort conditions
  cooldown
  evidence policy
  owner
```

The runner validates the target identity immediately before injection. It logs
the resolved explicit target and generation. It never kills by fuzzy process
name alone.

## Steady State

Before injecting a fault, prove a small useful behavior works:

- control plane heartbeat fresh;
- lane reports the expected revision/configuration;
- OpenCode server health succeeds;
- simulation controller is attached when required;
- a short smoke attempt completed recently;
- no unrelated attempt is active;
- resource use is below abort thresholds.

If steady state is absent, the experiment is `not-started` or
`inconclusive`; it is not a failed recovery test.

## Fault Catalog

### Simulated provider disconnect

Mechanism: `Llm.disconnect()` at a declared stream phase.

Trigger points:

- before output;
- after reasoning only;
- after partial text;
- during tool-input JSON;
- after a tool call is emitted;
- after a local tool settles but before provider terminal.

Assertions depend on delivery and output state: retry, continuation, explicit
failure, and tool settlement must match V2 policy. The session must remain
reusable.

### Provider pause or hang

Mechanism: a gated or never-ending simulated response within an outer timeout.

Assertions:

- pending UI state remains internally consistent;
- interruption succeeds;
- timeout/cancellation closes the provider invocation;
- no late output is accepted;
- another session remains usable in a concurrent campaign.

### Malformed provider stream

Drive's raw output can inject some OpenAI Chat event errors; the provider
contract harness covers broader wire faults.

Assertions:

- error becomes the expected canonical type;
- no hidden retry occurs after output;
- partial output and terminal failure are durably coherent;
- internal decoder defects are not leaked as confusing UI state.

### Controlled tool delay/failure

Mechanism: Drive tool controller waits, reports progress, fails, or is
interrupted.

Assertions:

- exactly one terminal tool state;
- failure is model-visible only through the declared tool error contract;
- defects remain defects;
- interrupted work cannot mutate the fixture later;
- next model/session action follows policy.

### TUI process termination

Mechanism: terminate the explicit lane-owned TUI process.

Assertions:

- server and session remain healthy;
- controller state is not consumed by the dead client unexpectedly;
- a replacement TUI can connect and rehydrate;
- no orphan terminal/renderer process remains.

### OpenCode server termination

Mechanism: terminate the explicit lane-owned server generation, then let the
supervisor restore it or invoke the declared restart operation.

Trigger points:

- idle;
- immediately after prompt admission;
- while provider request is open;
- during local tool execution;
- after terminal provider output but before all client observations;
- with queued input awaiting promotion.

Assertions:

- process death is detected promptly;
- write-ahead execution/recovery behavior matches V2 contract;
- durable facts survive;
- stale active tools settle on recovery;
- TUI reconnects or presents an actionable state;
- post-recovery smoke passes;
- no duplicate model execution is silently claimed as exactly-once behavior.

### Drive controller detach

Mechanism: close the backend controller connection while preserving the server.

Assertions:

- attachment generation changes;
- pending invocation handling matches the canonical protocol;
- reconnection does not attach two active controllers;
- response plans are not silently reassigned across attempts;
- settlement reports unresolved work.

### Network denial or route miss

Mechanism: request an unregistered simulated destination or make a contract
transport fail at a declared phase.

Assertions:

- no real egress occurs;
- typed transport error retains safe diagnostic context;
- retry follows delivery policy;
- lane remains controllable.

### Database pressure

Begin with non-destructive conditions:

- slow database operations through an injectable test boundary;
- bounded WAL/database growth;
- many sessions/messages;
- lock contention generated by supported concurrent actions.

Disk-full, file corruption, and forced I/O errors are later experiments in an
ephemeral disposable volume. Never run them against a shared or user-owned
database.

### Host resource pressure

CPU, memory, descriptor, and disk pressure are later container-level tests.
They require:

- a dedicated host or container;
- explicit cgroup/resource limit;
- supervisor and artifact store outside the constrained unit where possible;
- hard abort threshold;
- no credentials or persistent shared state;
- automatic cleanup verification.

## Failure Timing Matrix

For every lifecycle fault, classify the injection phase:

```text
before admission
after durable admission, before delivery
after delivery, before model request
request opened, no output
partial reasoning/text
partial tool input
tool executing
provider terminal, tools pending
step settlement
client projection only
```

Coverage reports phase/fault pairs. This is more useful than counting total
chaos runs.

## Recovery Invariants

The common recovery contract is:

1. The injected fault is observed and correlated with the experiment.
2. No unrelated lane or control-plane component is affected.
3. Durable admitted input is retained or explicitly rejected.
4. No tool or provider request remains permanently active.
5. No duplicate terminal outcome is created.
6. Process/controller generations converge to one active owner.
7. The TUI reaches a stable actionable or explicit error state.
8. A post-recovery synthetic prompt completes within its deadline.
9. Resource usage returns below the cooldown ceiling.
10. Cleanup verifies the fault mechanism itself left no residue.

Some faults intentionally fail the active attempt. Recovery success does not
rewrite that attempt to passed.

## Abort Conditions

Stop an experiment immediately when:

- target identity no longer matches the leased lane generation;
- an unrelated process or path could be selected;
- control-plane heartbeat is lost;
- host resource hard limit is approached;
- artifact storage or redaction is unavailable;
- a real credential or network destination appears in a deterministic lane;
- more than the allowed number of attempts/sessions would be affected;
- cleanup cannot be guaranteed.

Abort terminalizes the experiment distinctly from product failure.

## Scheduling and Exclusivity

Chaos experiments require an exclusive lane lease. The scheduler:

- drains ordinary work;
- verifies steady state;
- marks the lane `experimenting`;
- runs one experiment;
- performs cooldown and post-recovery smoke;
- returns the lane to `ready` or freezes/recycles it.

Use Effect `Schedule` for campaign cadence and health sampling. Do not put the
entire experiment inside an automatic retry. A repeated fault injection is a
new linked attempt.

## Evidence

Retain:

- experiment spec and digest;
- exact target and resolved process/container identity;
- pre-fault steady-state result;
- injection timestamp and phase proof;
- process generation changes;
- correlated OpenCode/session/simulation events;
- resource samples around the fault;
- frame immediately before and after recovery;
- active request/tool/session summaries;
- post-recovery smoke result;
- cleanup verification;
- original and reproduction attempt links.

Evidence collection is bounded. A log storm must not exhaust the host while a
fault is active.

## Baseline Comparison

For release soak tests, run matched workload profiles against baseline and
candidate revisions when capacity allows.

Compare:

- success and timeout rates;
- checkpoint latency quantiles;
- resource slope per completed attempt;
- database growth per session/message;
- reconnect/restart recovery time;
- number of residual active entities after attempts;
- lane recycle/crash frequency.

Pin workload, fixture, Drive revision, configuration, and response-plan digests.
Without matched inputs, a difference is a signal for investigation rather than
a release verdict.

## Runbooks for a Soak Failure

1. Stop admitting new work to the lane.
2. Preserve the first failed attempt and current lane health.
3. Determine whether a declared chaos fault was active.
4. Capture bounded process, storage, event, and frame evidence.
5. Run a clean ephemeral replay of the attempt.
6. If clean replay passes, snapshot or retain persistent state according to
   policy and attempt a stateful reproduction.
7. Compare resource trends with the control lane.
8. Classify product, harness, infrastructure, expected fault, or inconclusive.
9. Recycle only after evidence requirements are met.

## Initial Experiments

Begin with high-value faults already supported by Drive:

1. provider disconnect before output;
2. provider disconnect after partial text;
3. interruption during streamed tool input;
4. interruption during controlled tool execution;
5. OpenCode server restart while idle;
6. OpenCode server restart after a completed persisted session;
7. repeated fresh TUI reconnect to a persistent server;
8. 12-hour baseline conversation soak.

Only then add restart-during-execution and multi-fault experiments.

## Acceptance Criteria

Soak and chaos testing is operational when:

- every soak consists of bounded attributable attempts;
- lane age and cumulative workload accompany all resource samples;
- leak alerts use both absolute ceilings and trend evidence;
- every chaos experiment has a hypothesis, explicit target, trigger proof,
  recovery invariant, abort condition, and cleanup check;
- one experiment holds an exclusive lane lease;
- fault injection cannot resolve to unrelated processes, paths, or hosts;
- active attempt failure and recovery success remain separate outcomes;
- persistent failures freeze evidence before recycle;
- a post-recovery smoke verifies useful behavior, not only process liveness;
- no destructive storage or resource fault runs outside a disposable isolated
  environment;
- baseline and candidate soak comparisons record matched workload inputs;
- the control plane detects a lane that is alive but no longer completing work.
