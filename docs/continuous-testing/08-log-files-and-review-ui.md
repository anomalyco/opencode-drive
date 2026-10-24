# Log Files and Review UI

This document defines the local log-file format, collection pipeline, and human
review experience for continuous verification.

The core decision is:

> Every process writes bounded local files first; structured attempt events are
> indexed into a unified timeline; `apps/catalog` presents a searchable review
> UI over those records and artifacts.

This preserves evidence during exporter outages and makes local reproduction
easy, while still giving operators something much better than opening several
raw files in separate terminals.

## Current Foundation

[`packages/drive/src/log.ts`](../../packages/drive/src/log.ts) currently:

- writes Drive messages to `logs/opencode-drive.log` when
  `OPENCODE_DRIVE_LOG` is configured;
- prints friendly success/error messages to stderr;
- locates OpenCode's most recent `opencode*.log` file beneath the run
  artifacts;
- can forward error text to an owner log through
  `OPENCODE_DRIVE_OWNER_LOG`;
- treats log-file writes as best effort so logging does not change CLI
  behavior.

[`RunReport`](../../packages/drive/src/driver/report.ts) currently returns the
artifact root, retention state, recordings, and protocol compatibility. This is
a useful finite-run handoff, but it is not yet a structured operational log or
attempt timeline.

Keep that lightweight behavior for generic Drive CLI use. Build the richer
24/7 logging contract in the app/control-plane layer and add generic Drive
structured hooks only when they benefit multiple consumers.

## Goals

- every attempt has discoverable local logs even if remote telemetry is down;
- logs from scheduler, worker, Drive, OpenCode, TUI, inference, and tools can be
  viewed on one timeline;
- operators can filter and search without downloading a bundle;
- a log row links to its checkpoint, frame, session summary, exchange, tool,
  error, and artifact where applicable;
- live tail is available for active attempts;
- raw files remain downloadable and usable with ordinary command-line tools;
- content, cardinality, size, and retention are bounded;
- logging failure is visible but cannot change a product pass into a false
  failure unless required evidence policy says the attempt is inconclusive;
- viewer features do not modify OpenCode's simulation protocol.

## Two File Classes

### Structured JSONL event logs

One JSON object per line, emitted by components controlled by this system.
These are the canonical local diagnostic stream and can be indexed reliably.

Examples:

- control-plane events;
- lane-worker lifecycle;
- scenario checkpoints;
- Drive operations and controller summaries;
- inference/tool lifecycle summaries;
- evidence/redaction/cleanup events;
- resource samples at bounded cadence.

### Raw process logs

Unmodified or minimally framed stdout/stderr from OpenCode, TUI, build tools,
and other child processes. These preserve diagnostics the structured layer does
not understand.

Raw logs are linked into the timeline by process, time window, and generation.
They are not parsed as authoritative attempt state.

## Proposed File Layout

```text
<lane-generation>/logs/
  lane.jsonl
  processes/
    opencode.stdout.log
    opencode.stderr.log
    tui-<client>.stdout.log
    tui-<client>.stderr.log
    drive.stdout.log
    drive.stderr.log
  attempts/
    <attempt-id>/
      attempt.jsonl
      timeline.jsonl
      inference.jsonl
      tools.jsonl
      resource.jsonl
      process-excerpts/
      log-manifest.json
```

The exact directory names are implementation details of `apps/catalog` or the
control plane. `packages/drive` continues to expose an artifact root rather
than application-specific attempt taxonomy.

The attempt directory may contain hard links or references to lane process log
ranges rather than copying the same bytes. Portable failure bundles materialize
bounded excerpts.

## Structured Log Entry

Illustrative schema:

```text
LogEntry
  schemaVersion
  timestamp
  monotonicElapsedMs?
  sequence
  level: trace | debug | info | warn | error | fatal
  event
  message?
  component
  deploymentId
  laneId?
  laneGenerationId?
  attemptId?
  workItemId?
  campaignId?
  scenarioId?
  checkpointId?
  phase?
  process:
    role?
    generation?
  correlation:
    exchange?
    tool?
    sessionPlaceholder?
  outcome?
  error?: safe typed summary
  fields?: bounded JSON object
  sensitivity
  redactionVersion
```

Required fields are stable and schema-decoded. `fields` is not an unlimited
escape hatch: values must satisfy size, nesting, and key allowlists or be
replaced with a digest/summary.

## Event Names

Use namespaced stable event names:

```text
control.scheduler.tick
control.work.enqueued
control.attempt.reconciled
lane.generation.started
lane.health.changed
lane.resource.sampled
attempt.started
attempt.phase.changed
scenario.checkpoint.entered
scenario.checkpoint.completed
driver.ui.operation.started
driver.ui.operation.failed
driver.llm.request.opened
driver.llm.response.item
driver.llm.response.terminal
driver.tool.invocation.opened
driver.tool.invocation.terminal
opencode.process.exited
evidence.artifact.published
evidence.redaction.failed
attempt.terminal
```

The stable event drives filtering and grouping. `message` is concise human
context and may evolve.

Do not emit one row for every rendered pixel or high-frequency polling cycle.
Inference chunk rows should be summaries or enabled only for failure-focused
debug policy.

## Sequences and Ordering

Every structured writer assigns a monotonic sequence within its file. The
attempt coordinator also assigns an attempt timeline sequence to the events it
owns.

Across processes:

- retain source sequence;
- retain wall-clock timestamp;
- record process generation;
- use protocol/request/checkpoint causality when available;
- do not claim a strict total order from timestamp alone;
- mark rows whose order is approximate.

The indexed timeline may interleave sources for viewing, but raw source order is
always recoverable.

## Writer Design

Use an Effect `LogWriter` service with one scoped instance per process or lane.

Responsibilities:

- validate/encode entries with Effect Schema;
- add identity, timestamp, sequence, and redaction version;
- append newline-delimited UTF-8 JSON;
- batch low-priority entries through a bounded queue;
- synchronously or transactionally preserve critical lifecycle markers as
  configured;
- flush at attempt checkpoint/terminal and process drain;
- rotate by size/time;
- expose queue/drop/write health metrics;
- close through a scope finalizer.

The service returns typed failures for required audit/run-event writes. Ordinary
debug logging remains best effort and cannot fail product execution.

Do not call synchronous append for every output chunk in high-volume lanes.
The current Drive logger is fine for its small CLI messages; the continuous
writer needs bounded batching and explicit flush boundaries.

## Durability Tiers

Not every row needs the same durability.

### Tier 1: authoritative run events

Attempt creation, phase changes, selected command intent, checkpoint result,
fault injection, and terminal outcome belong in the run store or a durable
journal before/with side effects. JSONL is a local mirror.

### Tier 2: required failure evidence

Failure summary, process exit, current frame reference, and artifact manifest
must be flushed before cleanup where possible. Missing data marks evidence
degraded.

### Tier 3: diagnostic logs

Debug messages, resource samples, and raw child output use bounded asynchronous
files and may drop under extreme backpressure. Drop counts remain visible.

This prevents an overloaded debug stream from blocking model/session execution
while preserving the events needed for reconciliation.

## Rotation

Rotate lane/process logs by configured size and time, for example:

```text
lane.jsonl
lane.jsonl.1
lane.jsonl.2
```

Requirements:

- an active attempt can still resolve the file/range containing its events;
- rotation is atomic from the writer's perspective;
- retained segments are immutable;
- compression happens after close and outside critical attempt paths;
- total bytes per lane and process have a hard quota;
- oldest success-only segments expire before unresolved failure evidence;
- deletion uses validated lane-owned paths;
- the manifest records gaps, rotations, and drops.

## Child Process Capture

For every spawned process:

- capture stdout and stderr separately;
- prefixing/color is optional for an interactive console but raw file bytes
  should not gain ambiguous human prefixes;
- record process role, generation, command digest, start, and exit in structured
  logs;
- bound line length and total bytes;
- handle output without a final newline;
- preserve undecodable bytes through a safe representation or binary artifact;
- never allow child output to write arbitrary terminal control into the
  operator console by default;
- flush/close descriptors during drain.

OpenCode's own rotating logs remain separate artifacts. The collector indexes
their discovered paths and bounded relevant excerpts.

## Attempt Log Manifest

Every attempt produces a manifest:

```text
LogManifest
  schemaVersion
  attemptId
  target/config revisions
  sources[]:
    source id
    component/process role
    path or artifact reference
    byte range?
    first/last timestamp
    first/last sequence
    bytes
    digest
    complete
    dropped entries/bytes
    sensitivity
    redaction status
  timeline reference
```

The viewer uses the manifest rather than scanning directories heuristically.

## Indexing Pipeline

```text
local JSONL/raw files
       |
       +--> live tail stream
       |
       +--> attempt terminal collector
                 |
                 v
          validate + redact + index
                 |
        +--------+---------+
        |                  |
        v                  v
   searchable rows    immutable artifacts
```

Index at bounded checkpoints and terminalization. A background reconciler can
finish indexing after worker restart using the manifest and source sequences.

Indexing is idempotent by `(source, sequence, digest)`. Duplicate uploads do not
create duplicate viewer rows.

## Review UI Ownership

`apps/catalog` owns the OpenCode-specific review experience because it already
owns flow IDs, state taxonomy, captures, and review UI. The generic Drive
package must not import it or learn provider/scenario taxonomies.

The review UI consumes an API or static exported run bundle. It does not read
arbitrary server filesystem paths supplied by the browser.

## Review UI Information Architecture

### Fleet view

Shows:

- bot/profile status, including one row per provider contract bot;
- lane state and latest generation;
- active attempts;
- last success/failure and freshness;
- queue age;
- current target revision;
- active alerts and frozen lanes.

### Attempt list

Filter by:

- time range;
- target revision;
- bot, scenario, campaign, or provider;
- outcome and classification;
- lane kind;
- error/invariant tag;
- runtime path and protocol;
- expected chaos fault;
- evidence completeness;
- replay/retry relationship.

### Attempt detail

Header:

- outcome/classification;
- target and harness revisions;
- scenario/campaign/bot;
- lane generation;
- duration and last checkpoint;
- seed/trace/plan/package fingerprints;
- retry/replay links;
- triage owner/status.

Main panes:

1. normalized timeline;
2. terminal frame/screenshot and checkpoint captures;
3. session/inference/tool state summaries;
4. structured logs;
5. raw process logs;
6. artifacts and reproduction command/spec;
7. provider fingerprint diff when applicable.

### Comparison view

Compare:

- failed attempt against its last success;
- candidate against baseline revision;
- original property failure against minimized replay;
- native provider path against AI SDK fallback;
- before/after chaos recovery;
- two package fingerprint versions.

Align by checkpoint/event type rather than raw line number.

## Timeline Interaction

The timeline should support:

- compact phase bands for prepare, execute, evidence, cleanup;
- nested checkpoint spans;
- icons/colors for process, UI, inference, tool, provider, and fault events;
- jump from error to nearest frame and raw log excerpt;
- expand one row to show safe structured fields and causal links;
- collapse repeated resource/heartbeat events;
- “show only warnings/errors”;
- “show around failure” time window;
- copy stable event/attempt IDs;
- display approximate-order warning for cross-process rows;
- keyboard navigation and shareable filtered URL.

Avoid a decorative waterfall that hides actual messages. The textual event list
remains primary and accessible.

## Log Viewer

The log pane needs:

- component/source toggles;
- level and event filters;
- exact and token search over permitted fields;
- time-window brush linked to the timeline;
- virtualized rendering for large files;
- preserved whitespace for raw logs;
- JSON tree and raw-line toggle for structured entries;
- line wrapping toggle;
- correlation highlighting for exchange/tool/checkpoint placeholders;
- ANSI/control-sequence-safe rendering;
- dropped/truncated/gap indicators;
- download current safe view and original authorized artifact;
- live follow mode with pause and unseen-row count;
- permanent link to a source sequence, not a fragile visual row index.

Search should not send restricted content to a third-party service.

## Live Tail

Active attempts may stream new indexed entries over an app-owned SSE or
WebSocket endpoint.

Rules:

- authorize by attempt sensitivity;
- send already redacted structured rows;
- use source sequence for resume after reconnect;
- bound per-client buffer;
- drop/coalesce low-priority rows with an explicit gap marker;
- disconnect slow clients without affecting the attempt;
- final UI reloads the immutable terminal index after completion.

This endpoint is part of the review/control application, not the canonical
OpenCode simulation protocol and not `--command.ui.*`.

## Local Developer Experience

Every retained run should print or return:

- artifact root;
- Drive log path;
- OpenCode log path or pattern;
- attempt manifest path when running through the control layer;
- optional local review URL.

Provide a small app/control-plane command to pretty-print or tail JSONL:

```text
verification logs <attempt-id> --follow
verification logs <attempt-id> --component inference --level warn
verification open <attempt-id>
```

Names are illustrative. They are not Drive frontend protocol commands and must
not be added as `--command.ui.*` aliases.

Raw files remain compatible with `tail`, `jq`, `rg`, and editors.

## Redaction and Access

Default structured logs contain no raw prompt, response, tool argument/result,
HTTP body, credential, environment value, or arbitrary file content.

Represent content as:

- known synthetic marker;
- type and byte/character count;
- digest;
- schema-validity result;
- restricted artifact reference.

Raw process logs pass through redaction and secret scanning before publication.
The unredacted local source, if retained at all, has restricted access and short
retention.

The viewer visibly labels sensitivity and redaction status. It never fetches a
quarantined artifact into an ordinary page.

## Performance and Backpressure

- bounded writer queue per process;
- separate critical and diagnostic channels;
- maximum event and line size;
- sampled/coalesced chunk and resource logs;
- rotation and total byte quotas;
- index batches;
- viewer pagination/virtualization;
- bounded live-tail fan-out;
- stop large campaigns when artifact/log quota is threatened;
- preserve terminal/failure rows before success debug data.

Expose writer queue depth, write latency, dropped entries, raw bytes, rotation,
index lag, and viewer query latency.

## Failure Semantics

| Failure | Attempt effect |
| --- | --- |
| One debug append fails | Continue; mark log degraded and count drop |
| Required attempt journal write fails before action | Do not execute untracked action; fail/inconclusive as harness |
| Raw child log exceeds quota | Truncate/rotate, continue, show gap |
| Redaction fails | Quarantine artifact; continue collecting safe manifest |
| Index unavailable | Retain local files and retry; viewer shows delayed evidence |
| Local disk hard threshold reached | Stop new work and preserve essential terminal records |
| Viewer unavailable | Test execution continues; alert review-plane outage |

Logging must never silently convert a failure to success. Conversely, a best-
effort debug log failure does not imply OpenCode behavior failed.

## Testing

Test the complete path:

- Schema encode/decode and forward version handling;
- one JSON object per line under concurrent writers;
- source and attempt sequence monotonicity;
- flush on checkpoint, terminal, interruption, and drain;
- crash recovery from a partial final line;
- rotation while an attempt is active;
- manifest byte ranges and digest verification;
- dropped-entry and truncation markers;
- ANSI, control character, invalid UTF-8, and huge-line handling;
- secret sentinel redaction in structured and raw logs;
- indexing idempotency;
- live-tail reconnect/resume and slow-client backpressure;
- viewer filtering and permanent links;
- comparison alignment by checkpoint/event;
- authorization and quarantine behavior;
- exporter/index outage with local evidence preserved;
- retention deleting only validated targets.

## Implementation Sequence

### Step 1: stable JSONL schema

- define app-owned `LogEntry` and `LogManifest` Schemas;
- emit lane/attempt/checkpoint lifecycle events;
- mirror authoritative run events into JSONL;
- retain existing Drive/OpenCode raw logs;
- add schema/digest validation.

### Step 2: attempt timeline

- normalize worker, scenario, inference, tool, and process events;
- collect bounded raw excerpts;
- build `timeline.jsonl` at terminalization;
- add failure bundle links.

### Step 3: read-only review UI

- add bot/attempt list and detail routes in `apps/catalog`;
- implement filters, timeline, log pane, frame pane, and artifact list;
- serve static/local bundles first if that is simpler;
- add access/redaction labeling.

### Step 4: live operation

- incremental indexing;
- live tail with resume;
- fleet freshness/status view;
- comparison and triage annotations;
- remote artifact integration.

## Acceptance Criteria

Logging and review are ready when:

- every process has bounded local structured or raw files;
- every attempt has a schema-validated log manifest;
- critical attempt events are durable independently of best-effort debug logs;
- a failed attempt can be understood in one review page without manually
  correlating timestamps across terminals;
- the viewer filters by bot/provider/scenario, component, event, level, phase,
  outcome, and time;
- timeline rows link to frames, inference/tool summaries, raw excerpts, and
  artifacts;
- active attempts can be followed without backpressuring execution;
- source sequence and raw files remain available for exact diagnosis;
- rotation, truncation, drops, and indexing gaps are explicit;
- default logs and views contain no sensitive content;
- `apps/catalog` owns the OpenCode-specific viewer and `packages/drive` remains
  generic;
- no log/viewer command is added to the canonical `ui.*` simulation protocol.

