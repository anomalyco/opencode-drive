# Implementation Roadmap

This document turns the architecture into reviewable increments. Each milestone
must produce a usable result, tests, evidence, and an operational rollback. The
roadmap deliberately establishes run identity and logs before starting an
unattended loop: a 24/7 system that cannot explain its failures is only a log
generator.

## Guiding Priorities

1. Pin and describe exactly what is tested.
2. Make one finite attempt durable and reviewable.
3. Build provider/package fidelity around real code and fake transport.
4. Run logical provider bots continuously.
5. Add persistent OpenCode journey lanes.
6. Add generated state exploration, soak, and controlled chaos.
7. Add sparse real-provider drift checks last.

## Repository Ownership

### This repository

`packages/drive` owns only generic capabilities:

- simulation protocol client copied from canonical OpenCode;
- driver lifecycle;
- provider-neutral scripted output;
- generic tool control;
- frame/screenshot and recording primitives;
- compact generic run report;
- reusable generic logging hook only if multiple callers need it.

`apps/catalog` owns OpenCode-specific continuous-verification behavior:

- bot IDs and definitions;
- flow/scenario selection;
- provider/package coverage taxonomy;
- schedules and alert policy;
- attempt/run schemas specific to the application;
- evidence bundles and retention policy;
- review/log UI;
- reproduction entrypoints;
- dashboards and operator views.

### `../opencode`

The target repository owns:

- provider protocol and route tests;
- native package entrypoint tests;
- ModelResolver and AI SDK fallback tests;
- canonical `AIError`, session projection, and retry tests;
- programmable transport helpers close to `packages/ai`;
- HTTP/WebSocket cassettes;
- canonical simulation protocol changes.

Cross-repository scripts pin both revisions and collect results. Do not move
OpenCode provider behavior into Drive just to avoid coordinating two pull
requests.

## Proposed Application Layout

Names are provisional, but ownership should resemble:

```text
apps/catalog/
  continuous/
    schema/
      bot.ts
      work.ts
      attempt.ts
      log.ts
      artifact.ts
    bots/
      journeys.ts
      providers.ts
      properties.ts
      soak.ts
    scheduler/
    lane/
    runner/
    evidence/
    store/
    target/
    provider-contract/
    telemetry/
  scripts/
    verify-once.ts
    verify-service.ts
    verify-replay.ts
    verify-export.ts
  src/
    verification/
      FleetView.tsx
      AttemptList.tsx
      AttemptDetail.tsx
      Timeline.tsx
      LogViewer.tsx
      ArtifactViewer.tsx
```

The first implementation may use fewer files. Extract only stable concepts;
avoid a directory per one-line wrapper.

## Definition of Done for Every Milestone

- Effect Schemas decode all durable/config inputs;
- resources and background fibers are scoped;
- expected failures are typed;
- interruption remains interruption;
- tests cover success, expected failure, defect/cleanup, and cancellation where
  relevant;
- exact target/harness/config versions appear in output;
- no raw sensitive content enters default logs;
- documentation and runbook are updated;
- a rollback or disable mechanism exists;
- package/app ownership rules remain intact;
- no frontend simulation CLI alias or backend control command is introduced.

## Milestone 0: Freeze the Contracts

### Outcome

One checked-in architecture set and one machine-readable target audit establish
what the first system will test.

### Work

- keep this documentation set as the design baseline;
- resolve local `../opencode:v2` to an immutable commit for every run;
- record that the reviewed local ref was
  `c53f4cfb094bb87852d0c3c8e83933e902e81283`, while treating it only as the
  planning snapshot;
- inventory V2 native protocols, package-like entrypoints, `AISDKNative`
  mappings, dynamic fallback identities, canonical errors, retry classes, and
  existing recordings;
- snapshot Drive frontend/backend protocol capabilities;
- define initial bot IDs and owners;
- choose local paths and quotas for development without hardcoding user home
  paths in production configuration;
- decide the first deployment profile: dedicated single host is recommended.

### Deliverables

- `target-audit.json` generated for an exact OpenCode commit;
- provider/bot coverage manifest draft;
- configuration Schema and sample config;
- architecture decision record for local JSONL plus run store;
- risk register for real-provider credentials and fault experiments.

### Acceptance

- rerunning the audit on the same commit is deterministic;
- audit changes visibly when provider exports/mappings/packages change;
- every proposed bot points to real discovered targets or is marked planned;
- no source checkout is modified during audit.

## Milestone 1: One Durable Finite Attempt

### Outcome

A developer can run one existing catalog journey and receive a durable attempt
record, structured logs, artifacts, and a terminal outcome.

### Work

- define `WorkItem`, `Attempt`, `CheckpointRecord`, `FailureRecord`, `LogEntry`,
  `LogManifest`, and `ArtifactRecord` Schemas;
- implement a small local run store, likely SQLite or an append journal plus
  indexed metadata;
- wrap one existing executable scenario rather than copying it;
- record exact OpenCode/Drive/catalog commits and configuration digests;
- emit JSONL for attempt, phases, checkpoints, LLM summaries, tools, processes,
  evidence, and cleanup;
- retain current Drive and OpenCode raw logs;
- build a failure manifest with frame and bounded log excerpts;
- reconcile an attempt interrupted by killing the runner process in a test;
- expose a script such as `verify-once` that returns non-zero on failed or
  inconclusive outcome.

### Initial scenario

Use a deterministic prompt-to-text smoke flow with:

- fresh isolated OpenCode instance;
- one queued response;
- one final UI checkpoint;
- server projection assertion;
- frame on failure;
- Drive settlement.

### Tests

- successful attempt;
- UI wait timeout;
- unused and unexpected LLM response;
- OpenCode process exit;
- artifact capture failure with primary outcome preserved;
- cancellation during scenario;
- runner death after intent but before terminalization;
- log rotation/truncation at small test limits;
- secret sentinel absent from published bundle.

### Acceptance

- every started attempt reaches terminal state directly or via reconciliation;
- rerunning the script produces a new linked-independent attempt;
- the attempt can be diagnosed from its manifest and files;
- no existing catalog capture behavior changes.

### Control-plane technology decision gate

After this finite worker contract exists, run the vertical slice in [Elixir
control-plane option](./09-elixir-control-plane-option.md). This is the correct
decision point: before implementing the durable scheduler, but after the Bun
worker's job/event/result boundary is concrete.

Do not choose Elixir by rewriting the finite worker. Compare an Elixir host and
an Effect-only host around the same worker and attempt fixtures.

## Milestone 2: Log Viewer and Attempt Review

### Outcome

The finite attempt is understandable in one read-only `apps/catalog` view.

### Work

- add an attempt list with outcome, target, scenario/bot, duration, last
  checkpoint, and evidence status;
- add an attempt detail header and normalized timeline;
- add virtualized structured/raw log panes with source, level, event, time, and
  text filters;
- link timeline rows to frames, inference/tool summaries, and artifacts;
- add stable URL addressing for attempt and source sequence;
- show rotation, dropped rows, truncation, redaction, and approximate ordering;
- support local static bundle or local API first;
- add before/after comparison skeleton;
- keep capture catalog browsing intact.

### Tests

- render a successful and failed fixture bundle;
- filter by component/event/level;
- jump from failed checkpoint to log row and frame;
- malicious ANSI/HTML-like content is rendered inert;
- large log uses bounded DOM/rendering;
- missing/corrupt artifact is visible, not a page crash;
- restricted/quarantined artifact is not fetched;
- URL deep link restores filter and row.

### Acceptance

- a reviewer does not need multiple terminal windows to understand the sample
  failure;
- raw JSONL remains downloadable and CLI-friendly;
- viewer is read-only and does not add OpenCode `ui.*` commands.

## Milestone 3: Provider Contract Harness in V2

### Outcome

The actual V2 inference code is tested against programmable transport, and its
observed behavior is stored as a fingerprint.

### Work in `../opencode`

- define a behavior-fingerprint Schema and normalization;
- generalize existing Effect HTTP test helpers only where reuse is real;
- execute native routes through actual `RequestExecutor` and protocol code;
- cover the shared HTTP status/body/header corpus;
- cover response read failure, partial output, cancellation, malformed frame,
  incomplete stream, and tool-input assembly;
- capture typed `AIError`, request count, output-started, and events;
- assert session-facing projection and retry behavior in focused Core tests;
- index existing cassettes by provider/protocol;
- add a target command that emits a machine-readable report for orchestration.

### First contracts

1. OpenAI Chat, because Drive uses it end to end;
2. OpenAI Responses HTTP, because V2 directly selects it for
   `@ai-sdk/openai`;
3. Anthropic Messages, because V2 directly selects it for
   `@ai-sdk/anthropic`;
4. OpenAI-compatible Chat with explicit URL;
5. resolver and canonical error/retry matrix.

### Work in this repository

- run the target report as a finite app-owned work item;
- import only the report Schema/data, not target source modules;
- persist fingerprints/artifacts under attempts;
- show fingerprint diff and runtime path in the viewer;
- define logical provider bot profiles for the first contracts.

### Tests

- actual package path receives the request;
- real egress denied;
- synchronous construction throw remains distinct from typed stream failure;
- hang times out and interrupts transport producer;
- malformed stream shrinks or saves a minimal fixture;
- fingerprint IDs normalize while semantic change still diffs;
- package/lockfile change marks prior report stale.

### Acceptance

- no hand-authored provider package replica is used as the primary oracle;
- every first contract has valid, error, malformed, tool, and cancellation
  coverage as applicable;
- canonical error and retry mappings are explicit;
- target report identifies exact commit, lockfile, package version, protocol,
  and native/fallback path.

## Milestone 4: Scheduler and Logical Provider Bots

### Outcome

Provider/package contracts run continuously with one visible bot status per
meaningful provider/protocol path.

### Work

- implement durable schedule entries and work queue;
- implement leases, deadlines, attempt creation, and reconciliation;
- register bots from the generated coverage manifest plus app-owned policy;
- run bots through a bounded ephemeral worker pool;
- expose bot states: healthy, failing, stale, blocked, disabled, quarantined;
- compute last success/completion age independently of worker liveness;
- add fleet/provider matrix view;
- alert when a bot becomes stale or its reviewed fingerprint changes;
- run impacted bots on target/lockfile change and rotate full matrix hourly or
  nightly according to cost;
- implement backpressure and priority for replay versus routine rotation.

### Initial bot profiles

- `provider.openai.chat.native`;
- `provider.openai.responses-http.native`;
- `provider.anthropic.messages.native`;
- `provider.openai-compatible.chat.native`;
- `provider.resolver.matrix`;
- `provider.error-projection.session`.

### Tests

- schedule idempotency across restart;
- lease expiry and late worker result;
- one worker executes different bots without shared state;
- one bot failure does not stop others;
- worker outage turns bot stale instead of leaving green status;
- definition/config change creates new attempt identity;
- high-priority replay is fair and cannot starve freshness work;
- clean shutdown drains or terminalizes active work.

### Acceptance

- service can run unattended for 24 hours;
- every bot completes according to cadence or alerts as stale;
- no bot requires a permanently idle process unless isolation policy says so;
- fingerprint changes are reviewable and cannot silently become green.

## Milestone 5: Always-On Deterministic Journey Bots

### Outcome

At least two persistent OpenCode lanes continuously run high-signal synthetic
user journeys.

### Work

- implement lane registry/generation lifecycle;
- add one queued lane and one reactive lane;
- pin target artifact, ports, paths, database, and configuration per generation;
- bootstrap through handshake, capability validation, and smoke;
- lease one attempt at a time initially;
- launch fresh TUI/session per ordinary attempt;
- adapt existing executable scenarios to attempt/checkpoint records;
- add freshness metrics and independent evaluator;
- implement drain, freeze, recycle, and post-recycle bootstrap;
- add process supervision outside OpenCode;
- preserve failure evidence before recycle.

### First journeys

- submit and complete text;
- reasoning then text;
- one controlled tool success;
- tool rejection/failure recovery;
- provider disconnect before output;
- provider disconnect after partial output;
- create/reopen session;
- server restart after completed persisted session.

### Tests

- controller attachment loss;
- queued and served modes cannot mix;
- TUI process crash;
- OpenCode process crash;
- lane worker restart and reconciliation;
- stale heartbeat/freshness alert;
- scheduled recycle;
- unexpected port owner abort;
- local artifact store outage/quota.

### Acceptance

- an essential smoke completes at least every configured few minutes;
- process-alive but no-useful-work condition alerts;
- persistent lane age/state is visible;
- clean ephemeral replay links to the persistent failure;
- one failed lane does not remove all target coverage.

## Milestone 6: Scenario Registry Expansion

### Outcome

The existing catalog registry drives smoke, critical, recovery, and diagnostic
monitoring without duplicated scenario code.

### Work

- add app-owned monitoring metadata keyed by registered scenario ID;
- validate eligibility, lane type, timeout, fixture, evidence, and alert policy;
- add fixture profiles and deterministic reset digests;
- wrap ordered checkpoints with timing/evidence;
- migrate stable manual regression probes into registered monitored policy;
- add quarantine/known-issue status without rewriting failures as passes;
- add per-scenario reliability and checkpoint views;
- add exact reproduction spec and script.

### Acceptance

- no second copied journey DSL exists;
- every monitored scenario has bounded waits and postconditions;
- capture, reproduce, and monitoring use the same executable flow source;
- visual-only flows are not accidentally page-worthy monitors.

## Milestone 7: Stateful Property Campaigns

### Outcome

The existing lifecycle property probe becomes a continuously scheduled,
replayable, shrinkable campaign.

### Work

- extract/reference a versioned model and command trace;
- replace or record uncontrolled chunk randomness;
- emit command intent before execution;
- collect bounded observation after each relevant transition;
- enforce prompt ownership, history, tool settlement, terminal, recovery, and
  resource invariants;
- run discovery on persistent reactive lane;
- replay and shrink in ephemeral lanes;
- record semantic transition coverage;
- show original/minimized traces side by side.

### Initial campaigns

- prompt lifecycle;
- tool lifecycle;
- restart recovery.

### Tests

- generator precondition laws;
- bounded case budgets;
- trace round trip and direct replay;
- shrink validity;
- append-before-execute interruption;
- known seeded failures;
- cleanup after cancellation.

### Acceptance

- one failed invariant names command, pre-state, observation, and expected rule;
- seed plus explicit trace reproduces all harness-controlled choices;
- shrinking never destroys original evidence;
- transition coverage guides weights without mutating replay behavior.

## Milestone 8: Soak and Safe Chaos

### Outcome

Persistent lanes detect resource/state drift and execute initial controlled
recovery experiments.

### Work

- sample process/database/resource health;
- run baseline conversation and client-reconnect soak profiles;
- compute absolute ceilings and observational trend/slope reports;
- implement exclusive chaos experiment lease/spec;
- add steady-state probe, trigger proof, recovery invariants, abort conditions,
  cooldown, and cleanup;
- add supported Drive faults first;
- add explicit server/TUI/controller generation actions;
- implement freeze-before-recycle and post-recovery smoke;
- compare candidate and baseline soak profiles.

### Initial experiments

- provider disconnect before/after output;
- interruption during tool input/execution;
- TUI termination and replacement;
- server restart idle and after completed state;
- controller detach/reconnect;
- 12-hour baseline conversation soak.

### Acceptance

- each experiment has one declared fault and exact target;
- active attempt failure and recovery outcome are both visible;
- resource trend relates to lane age and completed workload;
- no destructive host/storage fault is enabled yet;
- failure evidence survives lane recycle.

## Milestone 9: Full Provider Matrix and Differential Parity

### Outcome

Every discovered V2 provider/package/protocol path has a logical bot and an
explicit coverage status.

### Work

- expand bots to Responses WebSocket, Gemini, Vertex variants, Bedrock Converse
  and Mantle, Azure, OpenRouter, xAI, and remaining fallback packages;
- split by semantic API/transport where required;
- run full protocol corpus once per shared protocol and representative subsets
  per provider;
- add model construction/auth/endpoint/options cases per entrypoint;
- add native-versus-AI-SDK differential fingerprints for migration candidates;
- gate `ModelResolver` mapping changes on reviewed parity;
- fill recording gaps identified by target `packages/ai/STATUS.md`;
- expose known gap, owner, and review expiry.

### Acceptance

- generated inventory has no silently uncovered runtime path;
- each provider bot has cadence, freshness, owner, version, and current result;
- shared corpus reuse avoids uncontrolled duplicate cost;
- fallback-to-native switches are visible before rollout.

## Milestone 10: Sparse Live Provider Drift

### Outcome

Budgeted live probes determine whether selected providers have drifted from
recordings and deterministic assumptions.

### Work

- create isolated credential/network profiles;
- implement provider/model allowlists and hard budgets;
- add global kill switch and circuit breakers;
- run minimal text and representative tool calls;
- refresh selected cassettes through explicit reviewed workflow;
- compare canonical fingerprint and optional fields;
- classify provider drift separately from OpenCode product failure;
- reconcile usage/cost;
- alert on probe age and credential/quota failure.

### Acceptance

- deterministic lanes still have no provider credentials/egress;
- live probes stop at budget and can be disabled independently;
- recordings are redacted/scanned/reviewed;
- a live provider outage cannot erase deterministic OpenCode health.

## Milestone 11: Production Hardening

### Outcome

The system can be operated by someone other than its author.

### Work

- OS/container supervision and resource limits;
- backup/restore and reconciliation drill;
- external heartbeat/freshness evaluator;
- retention and safe deletion jobs;
- artifact/upload outage handling;
- credential rotation and secret-exposure drill;
- control-plane authorization and audit log;
- rollout/rollback of target and harness generations;
- baseline/candidate capacity reservation;
- incident dashboards and runbooks;
- quarterly chaos/security exercise;
- SLO review from observed healthy variance.

### Acceptance

- 7-day unattended qualification with controlled maintenance;
- restart/restore does not lose or duplicate attempt outcomes;
- alert routes are tested;
- all hard resource/cost/security limits are enforced;
- an operator follows documented runbooks to restore known-good smoke;
- unresolved failures retain their first evidence through rollout/recycle.

## Cross-Milestone Test Strategy

### Pure and Schema tests

- configuration decoding;
- state-machine transitions;
- schedule decisions;
- fingerprint normalization/diff;
- redaction;
- failure classification;
- fixture/path validation;
- coverage-manifest derivation;
- log/timeline ordering.

Use property tests for algebraic laws such as round trips, bounded generators,
idempotent reconciliation, and valid shrink traces.

### Service tests

Use Effect test layers for clock, queue/store, target resolver, artifact store,
transport, and alert sink. Test scoped lifecycle and cancellation, not only
successful return values.

### Process integration

- worker/control restart;
- child output and exit capture;
- port/path ownership;
- drain/force-stop deadlines;
- local file rotation/quota;
- static review bundle generation.

### Real OpenCode integration

Run from package directories according to repository guidance. Keep live target
cases narrow and evidence rich. Protocol changes require both OpenCode
simulation tests and the full Drive suite.

## Rollout Strategy

For every service milestone:

1. run finite local qualification;
2. shadow without alerts/gates;
3. compare with existing manual/capture workflows;
4. enable recording and dashboards;
5. enable non-page notifications;
6. establish healthy variance;
7. enable release gates or pages only for stable high-signal bots;
8. keep global disable and last-known-good runner.

Do not page on a new generated campaign until its harness and failure rate are
understood.

## Initial Capacity

Start small:

- one control-plane process;
- one queued persistent lane;
- one reactive persistent lane;
- two to four ephemeral provider/replay workers;
- one local run database;
- local staged plus durable artifact store;
- no live provider bot until deterministic matrix is useful.

Scale based on queue age, freshness, scenario duration, shrink load, and host
resource data.

## First Four Pull Requests

An actionable opening sequence:

### PR 1: attempt and JSONL schemas

- app-owned Schemas;
- one finite smoke wrapper;
- local attempt directory and manifests;
- tests with fixture-only fake store;
- no daemon yet.

### PR 2: timeline and read-only viewer

- terminal bundle normalization;
- attempt fixture pages in catalog;
- log filter/timeline/frame integration;
- security rendering tests.

### PR 3: target provider report

- changes in `../opencode` for first contract fingerprints/common error corpus;
- orchestration script here pins target and imports report artifact;
- provider result fixture in viewer.

### PR 4: durable scheduler and provider bots

- work queue, leases, reconciliation;
- first logical provider bot registry;
- finite worker pool;
- freshness status and 24-hour shadow run.

This order produces value for the hardest inference/package problem before
introducing persistent OpenCode lane operations.

## Decisions to Revisit With Evidence

Do not decide these prematurely:

- SQLite versus network run database;
- single host versus cluster;
- exact lane count and concurrency;
- remote log search backend versus run-store index;
- memory/resource slope thresholds;
- how many provider bots need dedicated processes;
- live-provider cadence and models;
- whether generic structured logging belongs in `packages/drive`;
- whether a canonical simulation protocol needs additional stable request
  identity for concurrent routing.

The initial implementation records the data needed to make these decisions.

## Overall Acceptance

The project has reached its intended first mature state when:

- exact `v2` revisions run continuously under independent supervision;
- essential synthetic journeys and every meaningful provider/package contract
  have fresh visible bot health;
- provider mocks execute actual package code behind controlled transports;
- persistent lanes catch accumulated-state failures and ephemeral lanes replay
  them;
- stateful campaigns produce minimized, replayable invariant failures;
- soak and initial chaos experiments verify recovery safely;
- every attempt has append-only records, JSONL/raw log files, bounded artifacts,
  and one useful review page;
- absence of useful work alerts independently of ordinary failures;
- deterministic work has no real network or credentials;
- target, harness, scenario, plan, fixture, package, and configuration versions
  are attributable;
- failures remain failures even when retries or replays pass;
- operators can restore a last-known-good lane using documented runbooks;
- `packages/drive` remains generic and the canonical OpenCode simulation
  protocol remains authoritative.
