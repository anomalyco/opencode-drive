# Observability and Evidence

This document defines how the continuous-verification system proves what ran,
detects when useful work stops, and preserves enough evidence to diagnose a
failure without leaking sensitive content.

The design separates three concerns:

- **telemetry** supports aggregate health, trends, dashboards, and alerts;
- **run records** are the durable source of truth for attempts and outcomes;
- **artifacts** preserve bounded high-detail evidence for selected runs.

Logs alone are not a run database, and a dashboard is not a reproduction
artifact.

## Objectives

The evidence system must answer:

- Which OpenCode and Drive revisions were tested?
- Which lane, scenario, seed, response plan, package path, and configuration ran?
- What was the last meaningful checkpoint reached?
- Did the product fail, the harness fail, infrastructure fail, or did an
  expected injected fault occur?
- Was any output visible before the failure?
- Were retries, continuations, restarts, and controller generations involved?
- Is the environment completing useful work now?
- Can the exact action and response trace be replayed?
- Which evidence is safe to show broadly, and which is restricted?

## Signals

### Run records

Durable, queryable entities representing scheduled work, attempts, checkpoints,
failures, and artifacts. They are authoritative for pass/fail accounting.

### Traces

OpenTelemetry spans describe execution timing and causality across scheduler,
lane, scenario, Drive, and selected OpenCode boundaries.

### Metrics

Low-cardinality counters, gauges, and histograms support aggregate reliability,
latency, capacity, freshness, and resource analysis.

### Logs

Structured diagnostic events explain local decisions and failures. Logs carry
correlation fields but are not parsed as the primary state machine.

The concrete JSONL/raw file layout, writer behavior, indexing, live tail, and
`apps/catalog` review experience are specified in [Log files and review
UI](./08-log-files-and-review-ui.md).

### Artifacts

Frames, PNGs, recordings, event excerpts, response traces, minimized property
cases, resource samples, and redacted logs retained according to policy.

## Identity Hierarchy

Use explicit stable identifiers:

```text
deployment_id
  lane_id
    lane_generation_id
      work_item_id
        attempt_id
          checkpoint_id / exchange_id / artifact_id
```

Additional links:

- `parent_attempt_id` for retry, replay, or shrink relationship;
- `discovery_attempt_id` for minimized property reproductions;
- `baseline_attempt_id` for candidate comparison;
- `experiment_id` for chaos attempts;
- `campaign_id` for property, soak, or provider-contract campaigns.

IDs are fields in records and spans. They are normally not metric labels.

## Run Record Model

All records are schema-versioned and immutable after terminalization except for
explicit review annotations.

### Work item

Represents the scheduler's intent:

```text
WorkItem
  id
  kind: journey | property | provider-contract | soak | chaos | replay
  scenario/campaign/experiment identity
  priority
  requested target revision
  configuration version
  eligible lane kinds
  createdAt
  notBefore
  deadline
  trigger: cadence | commit | manual | alert | replay
  deduplication key
```

### Attempt

Represents one execution:

```text
Attempt
  id
  workItemId
  parent links
  laneId and laneGenerationId
  kind
  state
  outcome and classification
  target:
    opencode revision
    drive revision
    catalog revision
    lockfile digest
  configuration:
    config version/digest
    fixture digest
    scenario definition digest
    response plan digest
    inference strategy/version
    seed/trace digest
    provider/package/runtime path when applicable
  timing:
    scheduled, leased, started, first checkpoint, terminal
  phase and last checkpoint
  process generations
  retry/replay ordinal
  error summary
  evidence completeness
```

### Checkpoint attempt

```text
CheckpointRecord
  attemptId
  checkpoint address
  ordinal
  enteredAt
  completedAt
  outcome
  assertion summaries[]
  optional artifact references[]
```

### Failure

```text
FailureRecord
  attemptId
  stage
  typed category/tag
  classification
  safe message
  cause summary
  outputStarted
  expected fault correlation?
  retryability assessment
  first observedAt
  related process/request/tool safe summaries
  triage status and owner
```

### Artifact metadata

```text
ArtifactRecord
  id
  attemptId
  kind
  media type
  content digest
  bytes
  storage key
  sensitivity
  redaction status
  createdAt
  expiresAt
  producer version
```

The database stores metadata and safe summaries. Large content lives in an
artifact store.

## Attempt State Machine

```text
scheduled
   |
   v
leased -> preparing -> running -> collecting -> terminal
   |          |          |           |
   +----------+----------+-----------+
              failure/interruption
```

Terminal outcomes:

- `passed`;
- `failed`;
- `inconclusive`;
- `cancelled`;
- `timed-out`;
- `not-started` because preconditions or steady state were absent.

Classification is separate:

- `product`;
- `harness`;
- `infrastructure`;
- `expected-fault`;
- `provider-drift`;
- `security-policy`;
- `unknown`.

For example, an attempt may be `failed` and classified `harness`, or
`inconclusive` and classified `infrastructure`. Do not overload one enum with
both meanings.

## Atomicity and Append Order

Record intent before executing side effects:

1. create attempt;
2. record selected lane generation and configuration;
3. append command/checkpoint intent;
4. execute;
5. append observation and result;
6. terminalize once;

If the worker dies between steps 4 and 5, reconciliation sees a non-terminal
attempt and classifies it using lane/process evidence. It does not disappear.

Attempt terminalization uses a compare-and-set or transactional guard. Late
worker updates cannot overwrite a reconciler's terminal record.

## Tracing Model

Recommended span hierarchy:

```text
verification.work_item
  verification.attempt
    lane.prepare
    scenario.execute
      scenario.checkpoint
      driver.ui.operation
      driver.llm.exchange
      driver.tool.invocation
    evidence.collect
    lane.cleanup
```

Provider-contract attempts use:

```text
verification.attempt
  provider.resolve
  provider.request
    provider.transport.attempt
    provider.protocol.decode
  provider.fingerprint
```

Stateful cases add one span per generated command, not one span per random
number or frame.

Use named `Effect.fn` boundaries for meaningful operations. Provide one
OpenTelemetry layer at the application edge. Domain services emit spans and
metrics but do not choose exporters.

## Span Attributes

Safe, bounded examples:

- `verification.kind`;
- `verification.scenario` from a registered finite set;
- `verification.phase`;
- `verification.outcome`;
- `verification.classification`;
- `lane.id`, if lane count is bounded;
- `lane.kind` and `lane.generation` on traces/logs;
- `target.revision` on traces and records, not necessarily metrics;
- `inference.strategy`;
- `provider.protocol` and `provider.runtime_path`;
- `fault.kind` and `fault.phase`;
- `checkpoint.id` from the scenario registry;
- `error.tag` from a finite union;
- `output_started`.

Never attach raw prompts, model output, tool inputs/results, request bodies,
session IDs, request IDs, artifact paths, or arbitrary error messages as metric
labels. Restricted traces may opt into selected content only through explicit
policy.

## Metrics

### Scheduling and freshness

- `verification_work_items_total{kind,state}`;
- `verification_attempts_total{kind,outcome,classification}`;
- `verification_queue_age_seconds{priority,kind}`;
- `verification_attempt_start_delay_seconds{kind}`;
- `verification_last_success_age_seconds{journey_tier,lane_kind}`;
- `verification_last_completion_age_seconds{lane_kind}`;
- `verification_scheduler_heartbeat_age_seconds`;
- `verification_lane_heartbeat_age_seconds{lane}`.

Freshness metrics are essential. If the entire worker loop stops, no ordinary
failure counter increases.

### Journey latency

- `verification_attempt_duration_seconds{scenario_group,lane_kind,outcome}`;
- `verification_checkpoint_duration_seconds{checkpoint_group,lane_kind}`;
- `verification_time_to_first_output_seconds{strategy,lane_kind}`;
- `verification_recovery_duration_seconds{fault_kind}`.

Avoid one histogram label value for every individual high-churn test. Use
bounded groups and query exact attempt records for detail.

### Inference and tools

- `verification_llm_exchanges_total{strategy,outcome,terminal}`;
- `verification_llm_output_items_total{type}`;
- `verification_llm_exchange_duration_seconds{strategy}`;
- `verification_unexpected_llm_requests_total{lane_kind}`;
- `verification_unused_llm_responses_total{lane_kind}`;
- `verification_tool_invocations_total{tool_group,outcome}`;
- `verification_tool_duration_seconds{tool_group,outcome}`;
- `verification_active_llm_requests{lane}`;
- `verification_active_tools{lane}`.

### Lanes and processes

- `verification_lane_state{lane,state}` as a single current-value series;
- `verification_lane_age_seconds{lane}`;
- `verification_lane_generation_total{lane,reason}`;
- `verification_process_restarts_total{role,reason}`;
- `verification_controller_reconnects_total{lane}`;
- `verification_lane_rss_bytes{lane,role}`;
- `verification_lane_open_handles{lane,role}`;
- `verification_lane_database_bytes{lane}`;
- `verification_lane_artifact_bytes{lane}`.

### Properties and contracts

- `verification_property_cases_total{campaign,outcome}`;
- `verification_property_steps_total{campaign,command}`;
- `verification_property_transition_coverage_ratio{campaign}`;
- `verification_shrink_duration_seconds{campaign}`;
- `verification_provider_contracts_total{protocol,runtime_path,outcome}`;
- `verification_provider_fingerprint_changes_total{protocol,review_state}`;
- `verification_live_provider_probe_age_seconds{provider_group}`.

Metric cardinality is reviewed before deployment.

## Logs

Emit structured JSON or an equivalent structured format with:

- timestamp and level;
- event name;
- deployment/lane/generation/attempt correlation;
- component and phase;
- safe typed error fields;
- process role and revision;
- bounded contextual fields.

Examples of useful event names:

```text
attempt.leased
attempt.phase.changed
scenario.checkpoint.completed
llm.request.opened
llm.response.terminal
tool.invocation.settled
lane.health.failed
lane.recycle.started
attempt.evidence.degraded
attempt.terminalized
alert.fired
```

Do not rely on human prose as the only classifier. A message may accompany a
stable event name and typed fields.

### Log streams

Keep separate logical streams or fields for:

- control plane;
- lane worker;
- OpenCode server stdout/stderr;
- TUI stdout/stderr and renderer diagnostics;
- Drive controller;
- provider-contract harness;
- artifact/redaction service.

The attempt evidence collector creates bounded excerpts using correlation and
time windows. It does not copy an unbounded lane log into every failure bundle.

## Artifact Bundle

A failed attempt bundle should contain a manifest plus selected files:

```text
attempt.json
failure.json
timeline.jsonl
checkpoints.json
lane-health.json
processes.json
inference-trace.json
tool-trace.json
session-events.jsonl
frame.json
screenshot.png                 optional derived view
recording.*                    policy-dependent
property-trace.json            generated cases
provider-fingerprint.json      contract cases
logs/
  runner.jsonl
  opencode.stderr.log
  tui.stderr.log
```

The manifest lists every expected artifact and whether it is present, omitted
by policy, unavailable, failed redaction, or failed collection.

One artifact failure must not erase the primary attempt result. Evidence
completeness is a separate field and may trigger a harness alert.

## Timeline

Build one normalized timeline from run events, not by guessing order from
multiple wall-clock log files.

Timeline entries include:

- monotonic sequence within the attempt;
- wall time and monotonic elapsed time;
- source component;
- phase and event type;
- stable entity placeholder;
- safe summary;
- links to detailed artifacts.

Cross-process clock skew is possible. Causal sequence from the worker and
protocol events takes precedence over tiny timestamp differences. Record host
clock diagnostics when deployment spans machines.

## Frames, Screenshots, and Recordings

The canonical UI evidence is `ui.capture`, which returns a renderer-neutral
RGBA terminal frame through the OpenCode simulation protocol.

Drive's deliberate local `ui.screenshot` command calls `ui.capture`, renders a
PNG, and prints its absolute path for a standalone command. Continuous
verification stores the canonical frame and may derive a PNG for review. It
does not add `ui.screenshot` to OpenCode or expose media-directory bookkeeping
through normal usage.

Capture policy:

- always capture current frame on failure when the UI connection is healthy;
- capture selected before/after frames for recovery experiments;
- sample success frames;
- retain full recordings only for failures, explicit visual campaigns, or a
  low sample rate;
- bound frame/recording count and byte size per attempt.

## Session and Event Evidence

Store only the slice needed to reason about the attempt:

- selected session safe metadata;
- relevant message/part types and statuses;
- prompt markers or content digests;
- pending inbox/tool/form/permission summaries;
- correlated durable event names and sequence;
- server generation/recovery claim summaries;
- before/after projection digests.

Full user content is unnecessary for deterministic synthetic prompts. Use
known fixture markers and hashes. Real-provider or imported-session content has
stricter restricted handling.

## SLOs and SLIs

These are test-system objectives, not necessarily end-user product SLOs.

### Synthetic availability

```text
successful smoke attempts
-------------------------
eligible completed smoke attempts
```

Exclude only explicitly classified harness/infrastructure windows according to
documented policy; publish both raw and adjusted views to prevent convenient
reclassification.

### Completion freshness

Age since the last successful smoke for each required lane/revision.

This catches dead schedulers, blocked lanes, and silent telemetry failures.

### Attempt latency

Time from lease to declared final checkpoint, plus checkpoint and first-output
breakdown.

### Recovery success

Fraction of eligible chaos experiments that reach all recovery invariants and
post-recovery smoke within deadline.

### Evidence completeness

Fraction of failed attempts with all required safe artifacts collected and
verified.

### Reproducibility

Fraction of deterministic failures reproduced by exact replay within a bounded
number of linked attempts. This is diagnostic quality, not a reason to dismiss
non-reproducing failures.

## Initial Objectives

Start with conservative objectives and tune after observing variance:

- scheduler heartbeat age below 2 minutes;
- each required smoke lane has a completed attempt within 5 minutes;
- each target revision has a successful essential smoke within 10 minutes;
- 99% of healthy deterministic smoke attempts finish within their scenario
  timeout;
- 100% of attempts reach a terminal record through execution or reconciliation;
- 100% of failed attempts retain the run/failure manifests;
- 95% of failed UI attempts capture a terminal frame when the frontend
  connection remains available;
- no lane exceeds hard resource or artifact quotas.

Do not page on tight latency objectives until a stable baseline exists.

## Alerts

### Page-worthy

- no control-plane heartbeat;
- no successful essential smoke across redundant lanes beyond the freshness
  threshold;
- all lanes for the active target unhealthy;
- repeated data-loss, duplication, or security-policy invariant;
- artifact store or run database unavailable such that failures cannot be
  retained;
- unplanned real network egress or credential exposure signal;
- runaway resource/cost threshold.

### Ticket or non-urgent notification

- one deterministic scenario repeatedly failing while other smoke passes;
- candidate-only regression;
- provider contract fingerprint drift;
- one stale recording/live provider probe;
- gradual resource slope;
- evidence degradation;
- quarantined diagnostic campaign finding a known failure.

### Alert shape

An alert includes:

- concise symptom and affected target;
- first and latest failed attempt links;
- last known success;
- lane/revision/configuration;
- current phase and classification confidence;
- whether an intentional fault was active;
- dashboard and runbook link;
- mute/deduplication key.

Do not attach sensitive artifacts to alert payloads.

## Alert Evaluation

Evaluate absence-of-signal alerts from an independent process reading durable
heartbeats/run records. A worker cannot reliably alert that it has stopped.

Use consecutive windows or multi-lane corroboration for noisy failures, while
immediately surfacing high-severity invariants. Every alert rule has a unit test
against synthetic time series or records.

## Dashboards

### Fleet overview

- active target revisions;
- lane state, age, generation, and last heartbeat;
- queue depth/age;
- last successful smoke age;
- attempts by outcome/classification;
- active incidents and frozen lanes.

### Scenario reliability

- success/timeout/failure rate by scenario group;
- checkpoint latency distributions;
- first failure and last success;
- recent failure clusters by error tag;
- baseline versus candidate.

### Inference and package fidelity

- Drive exchange outcomes and unexpected/unused work;
- canonical protocol coverage;
- native versus fallback runtime counts;
- contract fingerprint changes;
- recorded/live provider freshness;
- canonical error/retry coverage.

### Soak and capacity

- lane resource series against attempt count and age;
- database/artifact growth;
- process restarts and controller reconnects;
- recovery duration;
- trend comparison with control lane.

### Evidence health

- artifact failures and redaction failures;
- bundle completeness;
- storage bytes and retention backlog;
- reproduction rate and shrink duration.

## Triage Workflow

1. Open the immutable failed attempt, not only the alert summary.
2. Confirm target, lane generation, scenario/campaign, and deliberate faults.
3. Inspect the normalized timeline and last checkpoint.
4. Compare UI, server projection, inference/tool trace, and process health.
5. Check whether a retry/replay exists; do not let it overwrite first failure.
6. Classify with evidence and confidence.
7. Link issue/owner and optional known-failure signature.
8. Reproduce in an ephemeral lane using recorded inputs.
9. Add a regression case or update harness contract after resolution.

Review annotations are append-only audit records. Original machine evidence is
never edited.

## Failure Signatures

Group failures using stable fields:

- scenario/campaign and phase;
- typed error tag;
- failed invariant ID;
- last checkpoint;
- process exit role/code;
- normalized top stack frames where safe;
- provider protocol/runtime path;
- expected fault kind and phase;
- output-started state.

Do not group solely by free-form message. Similar-looking timeout messages can
have unrelated causes, and dynamic IDs fragment groups.

Signatures support deduplication, not automatic dismissal. Every occurrence
remains an attempt record.

## Retention

Example policy:

| Data | Success | Failure |
| --- | --- | --- |
| Attempt/checkpoint metadata | 90 days or longer | 1 year or issue lifetime |
| Aggregate metrics | 13 months | Same |
| Structured logs | 7–14 days | Failure excerpts 90 days |
| Frames | Sampled, 7–30 days | 90 days or issue lifetime |
| PNGs | Derived/sampled | 90 days |
| Recordings | Sampled or campaign-specific | 30–90 days |
| Property traces | Summary only | Original and minimized, 1 year |
| Provider cassettes | Version-controlled when approved | Version-controlled |
| Restricted live content | Minimal, shortest practical | Policy-controlled |

Deletion jobs produce auditable counts and never follow artifact-supplied paths
outside the configured store.

## Redaction

Redact at collection and verify before publication.

Sensitive classes:

- credentials, tokens, cookies, and authorization headers;
- provider/account/project/deployment identifiers;
- raw prompts and outputs from non-synthetic sources;
- tool arguments/results and file contents;
- user paths and environment variables;
- HTTP bodies that may echo secrets;
- repository remotes and Git credentials.

Use deterministic placeholders where comparison needs identity consistency.
Store redaction status and redactor version in artifact metadata.

A redaction failure quarantines the artifact and marks evidence degraded. It
does not upload the unverified file to the normal review surface.

## Backpressure and Failure of Observability

Telemetry must not take down the product-under-test or fill the disk.

- metrics/log exporters use bounded queues;
- artifact capture has per-attempt byte/time limits;
- low-priority success artifacts are dropped before failure manifests;
- run-record terminalization has a durable local fallback when the central
  store is temporarily unavailable;
- a full artifact store stops new expensive campaigns while preserving smoke
  metadata;
- exporter failure emits a local health signal and evidence-degraded outcome;
- raw log rotation has hard limits.

The system alerts separately when observability is degraded.

## Clock and Duration Rules

- wall time identifies records and supports cross-system correlation;
- monotonic time measures durations within one process;
- store timestamps in UTC;
- record configured timezone only for human scheduling;
- never derive duration by subtracting wall clocks across hosts without clock
  quality evidence;
- retain schedule evaluation time so delayed work can be explained.

## Testing Observability

Test:

- Schema round trips and version decoding;
- exactly-once terminalization under worker/reconciler races;
- append-before-execute recovery;
- cardinality allowlists;
- redaction positive and adversarial cases;
- artifact manifest completeness and digest verification;
- retention target resolution safety;
- alert rules including absence of heartbeat;
- trace parenting across scoped fibers;
- exporter/backpressure failure behavior;
- timeline normalization with skewed timestamps;
- UI capture failure without loss of primary outcome.

## Acceptance Criteria

Observability is ready when:

- every scheduled work item and started attempt reaches a durable terminal or
  reconciled state;
- every attempt records exact revisions, configuration, lane generation, and
  scenario/campaign identity;
- freshness alerts detect silent absence of useful work;
- metrics have reviewed bounded dimensions;
- failure bundles include a manifest and report missing evidence explicitly;
- failed attempts are immutable and retries/replays are linked separately;
- traces use meaningful Effect operation boundaries and one edge exporter
  layer;
- raw prompt, model, tool, credential, and path content is absent from default
  telemetry;
- artifacts are redacted and digest-verified before normal publication;
- an observability failure cannot silently turn a failed attempt into a pass;
- dashboards distinguish product reliability, harness health, infrastructure,
  and provider/package fidelity.
