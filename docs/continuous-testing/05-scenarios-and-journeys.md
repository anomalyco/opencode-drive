# Scenarios and Journeys

This document defines how existing executable catalog flows become monitored
synthetic journeys, how new journeys should be authored, and how capture,
reproduction, and 24/7 verification share one source of truth.

## Principle: One Executable Journey Model

The catalog already has an executable-flow model in
[`apps/catalog/catalog/flow.ts`](../../apps/catalog/catalog/flow.ts). A flow
defines:

- a stable flow ID;
- title, group, and description;
- a non-empty ordered state list;
- metadata for each state;
- an Effect program that drives a real `Driver`;
- an ordered checkpoint callback.

The adapter `executableScenario(...)` adds response mode and client-isolation
metadata. The registry in
[`apps/catalog/scenarios/index.ts`](../../apps/catalog/scenarios/index.ts) is
already authoritative for capture and state reproduction.

Continuous verification must reuse that exact registry. Creating a second
“monitoring scenarios” directory with copied steps would cause IDs, waits,
fixtures, and expected behavior to drift.

The same journey can serve three consumers:

```text
ExecutableFlow
      |
      +--> catalog capture: checkpoint -> frame artifact
      |
      +--> reproduction: stop at selected checkpoint -> frame artifact
      |
      +--> monitoring: checkpoint -> timing + evidence + run event
```

The consumer supplies checkpoint behavior. The scenario owns user behavior and
assertions.

## What Counts as a Journey

A journey is a bounded, meaningful workflow with observable success criteria.

Good examples:

- submit a prompt and observe a completed assistant response;
- stream a patch call, approve permission, verify file and transcript state;
- reject a tool and verify recovery;
- answer a question form and verify the session projection;
- create a subagent, observe parent and child completion, open the child;
- restart the server and verify transcript rehydration;
- run concurrent tools and verify their settlement ordering.

A journey is not:

- a single low-level protocol call with no user outcome;
- an arbitrary sequence of keystrokes without state assertions;
- a screenshot script that only sleeps and captures pixels;
- an unbounded soak loop;
- a property campaign containing many generated attempts;
- a broad “test everything” script whose failure cannot identify a feature.

## Checkpoints Are Assertions

`executeFlow` verifies that checkpoints occur in the declared order and that
every declared checkpoint is reached. The scenario normally reaches a
checkpoint only after one or more `ui.waitFor`, SDK, filesystem, or lifecycle
assertions.

For monitoring, a checkpoint means:

- the journey reached a named observable state;
- all preceding scenario assertions passed;
- elapsed time can be attributed to a meaningful product phase;
- optional evidence can be captured without duplicating journey logic.

Do not add checkpoints for every keystroke. Add them for states a developer or
operator would recognize, such as “permission visible,” “tool running,”
“assistant settled,” or “composer actionable again.”

## Assertion Layers

A strong journey uses more than one observation surface where useful.

### UI assertion

Examples:

- visible transcript marker;
- semantic UI element state;
- composer focus/actionability;
- permission or form visibility;
- absence of an internal error string.

Prefer semantic UI state and stable node identity when the canonical protocol
provides it. Text markers remain useful but can drift with copy changes.

### SDK/server assertion

Examples:

- session exists and has expected parent relationship;
- prompt and assistant parts are present in the server projection;
- no pending form or permission remains after terminal state;
- shell or tool invocation has expected status;
- a queued prompt has one owner.

### Filesystem assertion

Examples:

- declared file changed as expected;
- rejected operation did not mutate the fixture;
- Git worktree is clean or has the expected diff;
- output file stays inside the isolated project root.

### Lifecycle assertion

Examples:

- response reached terminal state within a bound;
- TUI remains alive after interruption;
- server generation changed after restart;
- reconnect restored an actionable client;
- no unsettled simulated work remains at attempt cleanup.

Use the narrowest sufficient set. Duplicating the same assertion across every
surface adds fragility without diagnostic value.

## Journey Categories

### Smoke journeys

Characteristics:

- under a minute in healthy conditions;
- deterministic mock output;
- very small fixture;
- no intentional disruptive failure;
- validates the essential prompt-to-response path;
- runs frequently and powers freshness alerts.

A smoke journey must be reliable enough that one failure is informative, while
alert policy may still require consecutive failures before paging.

### Critical feature journeys

Characteristics:

- permission, tool, form, session, and subagent workflows;
- deterministic response plans;
- explicit end-state cleanup assertions;
- moderate cadence.

Most existing catalog lifecycle flows fit here.

### Recovery journeys

Characteristics:

- include interruption, provider disconnect, server restart, or rejection;
- assert recovery and post-failure reuse;
- run in a compatible reactive or chaos lane;
- retain more evidence than ordinary success runs.

### Diagnostic probes

Characteristics:

- target a known race or issue;
- may need many attempts;
- preserve seed and issue-specific evidence;
- may be excluded from release gates until stabilized;
- should migrate from `test/manual` when they become continuously valuable.

### Visual catalog flows

Some flows exist primarily to capture a design state. They are not
automatically good 24/7 health journeys. Monitoring eligibility should be
explicit so visual-only states do not consume operational capacity or page on
copy-only differences.

## Operational Metadata

The existing `ExecutableScenario` keeps source-of-truth identity and execution
metadata. Continuous verification needs additional app-owned policy without
polluting the generic flow model.

Proposed monitoring metadata:

```text
scenarioId
enabled
tier: smoke | critical | extended | diagnostic
cadence policy reference
timeout
eligible lane kinds
required protocol capabilities
required tool controls
database policy
reuse policy
evidence policy
alert policy
estimated healthy duration
owner/team
known issue or quarantine reference
```

Store this as a map keyed by registered scenario ID or as a typed wrapper built
from the registry. Type-level checks should prevent metadata for unknown IDs and
should identify required registered scenarios with missing policy.

Flow identity, taxonomy, and state metadata remain in the catalog definitions.
Operational policy does not move into `packages/drive`.

## Scenario Lifecycle Contract

Every monitored scenario has four phases.

### Preconditions

Declare and verify:

- eligible inference mode;
- required tools and permissions;
- Git fixture requirement;
- database persistence requirement;
- viewport/theme sensitivity;
- server and client reuse policy;
- required simulation capabilities.

The scheduler uses static preconditions for lane matching. The runner verifies
dynamic preconditions immediately before execution.

### Preparation

Preparation belongs to the monitoring adapter when it is common across
journeys:

- reset fixture files;
- launch a fresh TUI;
- create a fresh session;
- verify actionable composer;
- set attempt correlation context.

Scenario-specific preparation remains inside the scenario:

- create special SDK state;
- configure a specific controlled tool response;
- open a feature-specific starting screen.

### Execution

The scenario queues or serves model output, performs actions, waits for
observable conditions, and reaches checkpoints.

Every wait has a meaningful deadline. Use `ui.waitFor` rather than large
unconditional sleeps. A short sleep can be appropriate to capture an intended
mid-stream visual state, but it must not replace a completion condition.

### Postconditions

Before returning success, verify the state that matters beyond the final
rendered string:

- model response terminalized;
- tool/form/permission state settled;
- expected files or session records exist;
- no unintended pending work remains;
- composer is actionable when that is part of the contract.

Drive settlement provides a final guard for queued model and tool work at the
end of a finite driver run. A persistent lane also needs per-attempt
postconditions because lane settlement occurs much later.

## Fresh Session Preparation

The current catalog runner opens a new session through the TUI command palette.
That is valuable end-to-end coverage. The monitoring adapter should preserve it
for user-facing journeys.

Preparation sequence:

1. wait for at least one semantic UI element or known home state;
2. open the command palette;
3. select `New session` through stable UI control;
4. wait for an actionable composer;
5. record the selected session ID from the SDK when available;
6. verify it differs from the previous attempt's session unless reuse is
   declared.

An SDK-created session may be faster for specialized non-UI setup, but it does
not replace the smoke coverage of creating and navigating sessions through the
real client.

## Fixture Reset

Fixture reset must be deterministic and explicit.

Recommended design:

- define the canonical fixture contents in one module;
- compute a fixture digest stored in every attempt;
- restore only declared scenario-owned paths;
- remove a declared set of transient paths;
- verify reset result before executing;
- never touch `.opencode`, the lane database, logs, or artifact directories
  unless the lane policy explicitly requests it;
- fail preparation if a path escapes the project root after normalization.

A scenario that needs a materially different fixture should declare a fixture
profile. Avoid incrementally mutating a shared fixture until it happens to be
usable.

## Stable Markers

Use markers that represent behavior rather than incidental prose.

Preferred order:

1. canonical semantic element or node identity;
2. stable role/label/state from the simulation protocol;
3. deliberately authored deterministic mock text;
4. concise product copy that is itself under test;
5. timing-only capture as a last resort for a mid-stream visual state.

When product copy changes legitimately, update exact markers in the scenario.
Do not replace them with long unconditional sleeps or overly broad substring
matches that could pass on the wrong screen.

## Scenario IDs and Versioning

Flow and state addresses are user-facing reproduction identities. Preserve
them when behavior remains semantically the same.

Change an ID when:

- the scenario now represents a different user outcome;
- the checkpoint meaning changed incompatibly;
- replaying an old address against new code would be misleading.

Do not change an ID merely because implementation or copy changed.

Every attempt additionally records the source revision of the catalog app and
a scenario-definition digest. This lets an old failure point to the exact
journey implementation even when the stable ID remains.

## Captures in Monitoring

The authoritative catalog artifact is a normalized terminal frame. Monitoring
uses the same `ui.capture` output.

Evidence policy controls frequency:

- smoke success: final frame sampled or omitted;
- ordinary success: metadata and checkpoint timings only;
- property success: no frames unless sampled;
- any failure: current frame, recent event evidence, and logs;
- visual regression campaign: frame at every declared checkpoint;
- recording: failure-focused or sampled because encoding every success is
  expensive.

PNG remains a derived artifact. Do not change the canonical OpenCode protocol
or endpoint contract to support monitoring storage.

## Reproduction

The existing catalog supports replay through a canonical
`<flow-id>/<state-id>` address. Continuous verification extends the
reproduction specification with:

- source attempt ID;
- exact OpenCode and scenario revisions;
- lane configuration version;
- response plan digest or recorded reactive trace;
- seed and action trace for generated runs;
- fixture digest and optional redacted snapshot;
- requested terminal checkpoint or full journey;
- output artifact destination.

Reproduction produces a new linked attempt. It may stop at a selected
checkpoint for visual diagnosis or run the full journey for outcome comparison.

## Scenario Failure Classification

Examples:

| Failure | Classification guidance |
| --- | --- |
| `ui.waitFor` timed out and server projection also lacks state | Product failure likely |
| Text marker changed but semantic node and behavior are correct | Harness assertion drift |
| Checkpoints arrived out of declared order | Harness or product lifecycle regression; inspect evidence |
| Flow completed without a declared checkpoint | Harness failure unless product skipped an expected state |
| Unused queued response remains | Harness plan mismatch or product stopped requesting; inspect request history |
| TUI process exited during a valid action | Product failure unless host evidence indicates infrastructure |
| Frame capture failed after all postconditions passed | Evidence/harness failure; product outcome may remain passed with degraded evidence policy |

Automatic classification should remain conservative. Ambiguous cases are
`inconclusive` and enter triage; they do not become passes.

## Authoring Checklist

Before registering a monitored journey, verify:

- The journey tests a named user outcome.
- Its flow ID and checkpoint addresses are stable and descriptive.
- It declares the correct queue/serve mode.
- It declares client isolation and fixture requirements.
- Every state is reached only after a meaningful observation.
- Every wait has a bounded timeout.
- Deterministic text is authored by the response plan, not hoped for from a
  real provider.
- Tool calls use offered names and schema-valid inputs.
- Cleanup/postconditions prevent pending work from leaking into the next
  attempt.
- Failure evidence will identify the active phase and session.
- The scenario succeeds repeatedly against the baseline revision.
- A known failure can be reproduced by address, revision, and plan/seed.
- The operational cadence and alert tier match its reliability.

## Review Policy

Scenario changes should be reviewed like product code because they define the
monitoring oracle.

A pull request changing a monitored scenario should explain:

- which product behavior changed;
- whether IDs or checkpoint meanings changed;
- whether lane requirements or timeout changed;
- whether baseline history remains comparable;
- how the response plan changed;
- how the scenario was repeated to check flakiness;
- whether generated artifacts were regenerated where required.

Do not weaken an assertion solely to make a candidate revision green. Either
fix the product, update a legitimately changed contract, or quarantine the
journey with an owner, reason, and expiration.

## Quarantine

Quarantine is a visible operational state, not deletion.

A quarantine record includes:

- scenario ID;
- affected revisions or environments;
- reason and issue link;
- owner;
- start time and expiration;
- reduced cadence or alert behavior;
- evidence from the last unquarantined failure.

Quarantined journeys still run at a reduced cadence when safe so recovery is
detected. Their failures do not page according to the normal policy, but they
remain on dashboards and release reports.

## Migrating Manual Probes

The manual TUI regression directory contains high-value candidates. Migration
steps:

1. Identify the user-visible invariant and required lane type.
2. Extract reusable fixture and assertion helpers into app-owned scenario code
   when they are OpenCode-specific.
3. Define a stable flow or campaign ID.
4. Replace unrecorded environment variables with decoded campaign config.
5. Add deterministic response and fault plans.
6. Add failure evidence and replay metadata.
7. Characterize the probe against a known baseline over many attempts.
8. Register it with diagnostic cadence first.
9. Promote it to critical policy after its harness false-positive rate is
   acceptable.

The seeded lifecycle probe is better represented as a property campaign than a
single deterministic flow; see
[Stateful property testing](./06-stateful-property-testing.md).

## Proposed Directory Shape

```text
apps/catalog/
  catalog/
    flow.ts                  existing executable flow contract
  scenarios/
    index.ts                 existing authoritative registry
    ...                      existing OpenCode journeys
  continuous/
    policy.ts                monitoring policy keyed by scenario ID
    fixture.ts               reset profiles and digests
    run-scenario.ts          monitoring adapter and checkpoint wrapper
    registry.ts              validated registry + policy projection
    errors.ts                schema-backed app errors
  scripts/
    continuous-runner.ts     application entrypoint
```

Names may change during implementation, but ownership should not: OpenCode
journeys and their policy remain under `apps/catalog`; the published package
must not import them.

## Acceptance Criteria

Scenario integration is ready when:

- capture, reproduction, and monitoring use the same registered flow program;
- monitoring records every ordered checkpoint without changing scenario code;
- one scenario can run in a fresh attempt TUI against a persistent server;
- fixture reset and postconditions prevent ordinary cross-attempt leakage;
- queue/serve and client-isolation requirements drive lane selection;
- every monitored journey has owner, timeout, cadence, and alert metadata;
- text-marker drift is distinguishable from server-state failure;
- failures can be reproduced with the same flow address and exact revision;
- quarantines are visible and expire;
- no OpenCode-specific flow ID or monitoring taxonomy is added to
  `packages/drive`.
