# Stateful Property Testing

This document defines the generated testing layer for OpenCode's long-lived and
concurrent behavior. It explains what “property testing” means in this project,
which parts are useful, and how failures remain understandable and replayable.

## Terminology

Several related techniques are often grouped under property testing:

**Property-based testing**
: Generate many inputs and assert a rule that should hold for all of them.

**Stateful property testing**
: Generate commands whose validity and expected result depend on the current
  abstract state.

**Model-based testing**
: Maintain a small reference model and compare the real system after each
  command with the model's predicted state.

**Metamorphic testing**
: Apply a transformation that should preserve or predictably change the result,
  even when the exact output is not known in advance.

**Fuzzing**
: Explore large or malformed input spaces, usually with weaker semantic
  knowledge. Stateful property testing uses more domain knowledge than generic
  fuzzing.

For OpenCode's TUI and session lifecycle, the primary method is **stateful
model-based property testing**. Fixed catalog journeys remain the first line of
defense; generated campaigns explore the ordering space between them.

## Why This System Needs a State Model

An arbitrary keystroke fuzzer will spend most of its time producing irrelevant
or invalid interaction. The interesting bugs occur at valid boundaries:

- a second prompt arrives while the first response is streaming;
- interruption occurs between tool-input fragments;
- the server restarts after durable admission but before visible delivery;
- a controlled tool completes while the provider stream fails;
- a TUI reconnects while a permission or form is pending;
- a queued input is promoted after completion, interruption, or recovery;
- a session is opened from another client during an active execution.

A model knows when those actions are legal and what must remain true afterward.
This concentrates generated work on meaningful lifecycle interleavings.

## Existing Seed

[`packages/drive/test/manual/tui-regressions/lifecycle-properties.ts`](../../packages/drive/test/manual/tui-regressions/lifecycle-properties.ts)
already demonstrates the approach. It has:

- a controlled random seed;
- an abstract lifecycle state;
- preconditioned actions;
- separate transitions for submit, queued submit, reasoning, text, tool input,
  tool execution, completion, interruption, and provider disconnect;
- UI and server invariants;
- a failure file containing seed, trace, state, events, and terminal frame.

The continuous system should first make this campaign operable and shrinkable,
then generalize its reusable pieces. It should not replace it with an unrelated
property framework merely to gain terminology.

## Test Architecture

```text
             generated command
                    |
       +------------+-------------+
       |                          |
       v                          v
 reference model predicts     real command executes
 legal transition            through Drive/OpenCode
       |                          |
       +------------+-------------+
                    v
              observation snapshot
                    |
          invariants + model comparison
                    |
             trace item persisted
```

The reference model is intentionally smaller than OpenCode. If it reproduces
the complete product implementation, it will reproduce the same bugs and be
too expensive to maintain.

## Campaign, Case, Step, and Trace

**Campaign**
: One configured exploration run: target revision, model version, seed range,
  step budget, action weights, and lane policy.

**Case**
: One generated initial state and command sequence. A case has one root seed.

**Step**
: One chosen command, its pre-state, execution, observation, invariant results,
  and post-state.

**Trace**
: The ordered replay artifact for a case. It records actual choices rather than
  assuming the random generator can be reconstructed forever.

A 24/7 bot schedules bounded campaigns. It never runs one unbounded property
loop whose partial work disappears when the process stops.

## Reference State

Start with a lifecycle model that tracks only properties needed to select
commands and assert ownership.

Illustrative model:

```text
ModelState
  generation
    server
    tui
    controller
  session
    id?
    execution: idle | pending | streaming | terminal | unknown
    activePrompt?
    queuedPrompts[]
    visiblePrompts[]
    visibleAssistantParts[]
    activeToolCalls[]
    settledToolCalls[]
    pendingPermission?
    pendingForm?
  inference
    requestId?
    phase: none | opened | reasoning | text | tool-input | finished | disconnected
    outputStarted
  fixture
    expectedFiles
  budgets
    commandsRemaining
    modelStepsRemaining
    restartsRemaining
    faultsRemaining
```

Use explicit `unknown` or observation-unavailable states when the public
surface cannot determine a fact. Do not invent certainty to make the model
easier.

The persisted model is schema-versioned. A trace records the model version that
interpreted it.

## Observed State

After each command, collect the smallest useful snapshot from independent
surfaces:

- TUI semantic tree or normalized frame;
- current session ID and selected client state;
- server session/message projection;
- pending inbox, permission, form, and tool state when exposed;
- Drive LLM pending request summary;
- controlled tool invocation summary;
- server/TUI/controller generation IDs;
- fixture digest and selected file facts;
- recent correlated OpenCode events;
- process liveness.

Observation is bounded by a deadline. An observation timeout is a real case
outcome; the model must not silently use stale prior state.

Not every invariant needs every surface. The snapshot collector can lazily
obtain expensive evidence only when the current command or a failed invariant
requires it.

## Command Contract

Every generated command defines:

```text
Command
  id and schema version
  parameters
  precondition(ModelState) -> boolean
  expected transition(ModelState) -> ModelState or allowed states
  execute(Driver, parameters) -> Effect
  observe requirements
  postcondition(before, observation, after)
  quiescence policy
  timeout
  destructive/fault budget cost
  shrink(parameters)
```

Command selection evaluates preconditions first. A generator that repeatedly
chooses illegal commands is a generator-quality defect, not product coverage.

The expected transition may be a set when external scheduling makes more than
one state legitimate. That set must remain narrow and explainable; “anything
can happen” is not a model.

## Initial Command Set

### Session and prompt commands

- create a new session through the TUI;
- submit a prompt while idle;
- submit or steer a second prompt while work is active;
- change or cancel a queued input where public behavior supports it;
- open another existing session;
- return to the active session;
- start a second TUI client in a dedicated multi-client campaign.

### Inference progress commands

- release one reasoning fragment;
- release one text fragment;
- begin tool input;
- release one tool-input fragment;
- finish a tool call;
- finish the provider exchange;
- disconnect before output;
- disconnect after output;
- leave the stream paused while another action occurs.

The response plan must expose deterministic gates. Sleeping for a random period
does not establish which lifecycle phase was reached.

### Tool and form commands

- report controlled tool progress;
- complete a controlled tool successfully;
- fail a controlled tool;
- answer a question form;
- reject or approve permission when a scenario intentionally configures it;
- interrupt while a tool or form is pending.

### Lifecycle commands

- interrupt the active session;
- restart the OpenCode server;
- restart the TUI;
- detach and reattach the Drive controller;
- wait for a declared stable boundary;
- reconcile/reobserve after an ambiguous transport outcome.

### Fixture commands

- read a declared file through the UI/tool path;
- apply a controlled edit;
- verify Git/file digest;
- restore the fixture at a legal campaign boundary.

Never generate destructive shell commands or arbitrary paths. Generated file
operations are chosen from a fixture-owned allowlist.

## Preconditions

Examples:

| Command | Preconditions |
| --- | --- |
| Submit idle prompt | TUI actionable, session selected, no active inference |
| Queue second prompt | Active execution, queue budget available |
| Emit text delta | Matching Drive request open, no terminal event |
| Start tool input | Request offered at least one controlled tool, no terminal |
| Complete tool | Matching invocation active and controller attached |
| Interrupt | Session is known and execution may be active |
| Restart server | Restart budget available, no lane-wide maintenance lock |
| Answer form | Exactly one matching pending form is observable |

Preconditions are based on the model plus recent observation. When observation
contradicts the model, fail the invariant before choosing another command.

## Core Invariants

### Prompt ownership

Every synthetic prompt has exactly one logical owner:

- admitted and pending;
- delivered into visible/projected history;
- cancelled according to product semantics;
- or rejected with an explicit terminal error.

It must not be lost, duplicated, or simultaneously counted as pending and
delivered when those representations are intended to be exclusive.

### Monotonic durable history

Once a durable user or assistant fact is observed in the authoritative session
projection, later observations do not erase it unless a declared product
operation such as revert changes the visible history according to its contract.

Client rendering may temporarily lag. The invariant uses bounded eventual
visibility rather than requiring every surface to update in one instant.

### Exactly one terminal outcome per logical step

A started logical step eventually has one terminal outcome: ended or failed.
Retries may create physical attempts without consuming a new logical step as
defined by V2 session semantics.

### Tool settlement

Every locally called tool eventually reaches exactly one terminal state.
Interruption, rejection, provider failure, and server recovery must not leave a
tool permanently `streaming` or `running`.

### No output after terminal

No provider or tool output is accepted after its terminal event. If the test
deliberately sends late output, rejection itself is the expected behavior and
the session remains usable.

### Actionable recovery

After a bounded terminal or recovery sequence, either:

- the composer becomes actionable and another prompt can be accepted; or
- the UI presents a stable, user-actionable error/recovery state declared by
  the scenario.

An endless spinner or inert composer violates the invariant.

### One active execution owner

Within the current single-process V2 execution model, concurrent resumes for
the same session coalesce or join according to the product contract. They do
not create conflicting simultaneous model executions.

### Cross-session independence

Work in one session must not consume another session's queued Drive response,
tool completion, permission answer, or UI selection. Test this only in a served
handler or otherwise explicitly routed lane; ordinary queued mode intentionally
cannot safely support unrelated concurrent requests.

### Resource settlement

After each case:

- no case-owned request remains pending;
- no case-owned tool remains active;
- no case-owned child process or TUI remains alive;
- no response queue entry remains unused;
- all scoped recorders and files are closed.

A cleanup failure fails the case even if earlier behavior passed.

## Temporal Properties

Many important properties include time but should not be encoded as arbitrary
sleeps.

Examples:

- after submit, a request opens within the request-start deadline;
- after releasing a text chunk, it becomes visible within the projection/UI
  deadline;
- after interruption, the request disappears from `llm.pending` within the
  settlement deadline;
- after server restart, the TUI reconnects or shows an actionable failure
  within the recovery deadline;
- after terminal execution, no active tool remains beyond the cleanup deadline.

Record the actual duration. A timeout fails with the expected transition,
current observation, and recent event trace.

## Quiescence

Some assertions require a stable boundary; others intentionally inspect
mid-flight state.

Each command declares one policy:

- `immediate`: observe directly after the command;
- `condition`: wait for a named semantic condition;
- `eventual`: repeatedly observe until the invariant holds or the deadline
  expires;
- `terminal`: wait for session execution to settle;
- `none`: the next command intentionally races the current work.

Global “wait until everything is idle” logic would erase the interleavings the
campaign exists to test.

## Generation Strategy

Use weighted state-dependent selection.

Example initial weights:

```text
idle:
  submit prompt             60
  open/new session          20
  restart server             5
  restart TUI                5
  inspect stable state      10

streaming:
  emit next fragment        35
  queue/steer prompt        20
  interrupt                 15
  disconnect                10
  restart server             5
  inspect mid-flight        15
```

Weights are campaign configuration and recorded with the case. Coverage data
should influence later tuning, but production failures must not silently mutate
the generator during a replay.

Favor useful traces:

- ensure most cases reach at least one complete prompt/response;
- reserve a bounded percentage for early failure paths;
- cap repeated no-progress actions;
- bias toward lifecycle boundaries not recently covered;
- use separate campaigns for multi-client, restarts, and destructive faults so
  ordinary lifecycle exploration remains productive.

## Randomness and Replay

A seed is necessary but insufficient when the system contains uncontrolled
randomness or version-dependent generators.

Persist:

- root seed;
- generator and model version;
- action-weight configuration digest;
- every selected command and parameter;
- actual inference chunk plan;
- target and Drive revisions;
- fixture digest;
- timing/fault choices;
- any observed nondeterministic branch selected by the product.

Replay consumes the recorded trace directly. It does not regenerate commands
from the seed unless validating the generator itself.

The current Drive text chunking uses `Math.random`, which is not controlled by
an Effect seeded random service. Generated campaigns must use explicit chunk
plans or record emitted chunks before claiming deterministic replay.

## Shrinking Stateful Failures

Naively removing commands can make later commands illegal. Stateful shrinking
must replay candidates through the reference model.

Shrink order:

1. remove suffix after the first failed invariant;
2. remove whole command ranges while preserving preconditions;
3. remove independent session detours;
4. reduce restart/fault count;
5. shrink prompt text to stable markers;
6. shrink tool input structures;
7. merge or remove inference fragments;
8. reduce timing delays toward boundary values;
9. normalize IDs and fixture data.

Every shrink candidate runs in a fresh ephemeral environment. Persistent lane
state is useful for finding the failure but is not a safe substrate for repeated
candidate replays.

Stop shrinking when:

- the time budget expires;
- a stable minimum is reached;
- the failure becomes non-reproducible;
- infrastructure prevents safe replay.

Retain the smallest reproducing trace, the original trace, and shrink history.

## Metamorphic Properties

Metamorphic cases broaden coverage without requiring exact model prose.

Examples:

- splitting one valid text delta into more chunks preserves final text and
  terminal state;
- combining adjacent text deltas preserves final text;
- changing harmless JSON object key order in tool arguments preserves parsed
  input;
- reopening the same completed session from a fresh TUI preserves durable
  transcript facts;
- repeating a read-only navigation sequence preserves server state;
- restarting a client after durable completion preserves the same session
  projection;
- using a queue versus an equivalent reactive response plan preserves the
  user-visible terminal outcome;
- replaying a recorded provider cassette produces the same canonical event
  fingerprint after normalization.

Only declare a metamorphic relation after confirming it is a product contract.
Provider-specific chunk or metadata differences may be intentionally visible.

## Concurrency Campaigns

Concurrency needs explicit ownership and stronger routing.

Use separate campaigns for:

- two sessions executing concurrently;
- two TUI clients observing one session;
- parallel tool calls within one model step;
- controller detach/reattach with pending work;
- server restart while client and controller reconnect;
- queued steering arriving at a safe step boundary.

These campaigns use served inference with request-aware correlation. They must
not share an ordinal response queue across unrelated sessions.

Concurrency assertions focus on causal and per-source order, not a single total
order where the product allows legitimate interleavings.

## Coverage

Track semantic transition coverage rather than raw command count:

- state entered;
- `(state, command)` pair;
- `(state, command, outcome)` triple;
- adjacent command pair;
- fault injection phase;
- recovery transition;
- invariant evaluated;
- tool/provider terminal combination;
- server/TUI/controller generation change;
- partial-output status at failure.

Coverage dimensions use bounded enumerations. Seeds, session IDs, prompts, and
request IDs do not become metric labels.

A campaign report identifies unreachable or never-selected transitions. That
may reveal bad weights, impossible preconditions, missing instrumentation, or
dead product behavior.

## Failure Classification

| Observation | Classification guidance |
| --- | --- |
| Model transition was wrong but product behavior matches documented contract | Harness model defect |
| Generated command violated its own precondition | Generator/harness defect |
| Product lost or duplicated a prompt | Product failure |
| Observation endpoint timed out while process health is good | Product or observability failure; preserve as inconclusive until triage |
| Replay cannot reproduce because chunk randomness was unrecorded | Harness reproducibility failure |
| Persistent lane fails but clean replay passes | Product state-leak candidate, not a pass |
| Case exceeds host resource budget | Infrastructure or product leak depending attribution evidence |
| Shrinker cannot reproduce original failure | Original remains failed; shrink result is supplemental |

## Running Continuously

Use two lane types:

### Persistent discovery lane

- retains server/database state across cases;
- runs bounded cases repeatedly;
- uses a fresh session and TUI by default;
- occasionally runs declared reuse cases;
- records lane age and cumulative counts;
- recycles on policy, never silently after a suspicious failure.

### Ephemeral replay/shrink lane

- starts from the exact target revision and fixture;
- replays a recorded trace;
- retries only as linked diagnostic attempts;
- performs shrinking in isolated cases;
- never overwrites the discovery evidence.

If a failure depends on accumulated persistent state, preserve or snapshot the
lane data according to security policy before recycling it.

## Effect Structure

The implementation should expose focused services such as:

- `CampaignGenerator` for seeded command choice;
- `ReferenceModel` for valid transitions;
- `Observation` for bounded product snapshots;
- `InvariantEvaluator` for typed results;
- `TraceStore` for append-before-execute records;
- `CaseRunner` for scoped command execution;
- `Shrinker` for ephemeral candidate search.

Campaign configuration and trace values use Effect Schema. Each case and each
shrink candidate runs in its own scope. Commands use named `Effect.fn`
boundaries so spans identify the command and phase without logging prompt
content.

Expected command, observation, and invariant failures remain typed. Defects and
interruptions retain their native meaning.

## Test the Tester

The property harness needs its own deterministic tests:

- generated commands always satisfy their preconditions;
- budgets make every generated case finite;
- the same explicit trace produces the same model transitions;
- trace encoding/decoding round-trips;
- append-before-execute survives interruption;
- invalid traces fail with a typed replay error;
- shrinking never emits a trace invalid under the reference model;
- each known seeded fixture triggers its expected invariant;
- fake observations verify every invariant's positive and negative cases;
- cancellation closes scopes and marks the case interrupted.

Use small property tests for pure model and trace laws, plus selected live Drive
integration cases for the execution boundary.

## Initial Campaigns

Start with three narrow campaigns:

1. **Prompt lifecycle**: idle submit, queued submit, reasoning/text progress,
   completion, interruption, and disconnect.
2. **Tool lifecycle**: streamed input, valid and invalid arguments, controlled
   tool progress, completion, failure, and interruption.
3. **Restart recovery**: durable prompt admission, server restart at selected
   boundaries, transcript rehydration, and post-recovery prompt.

Do not start by combining every command. Each campaign should first produce
stable, replayable failures and useful transition coverage.

## Acceptance Criteria

Stateful property testing is operational when:

- every case is bounded by command, time, inference, tool, and fault budgets;
- commands are selected only when their preconditions hold;
- core prompt, history, terminal, tool, recovery, and resource invariants run
  after relevant transitions;
- every choice and actual inference chunk is replayable from the stored trace;
- failures preserve model state, observation, recent events, logs, and frame;
- shrink candidates run in isolated environments and retain the original
  failure evidence;
- persistent discovery and ephemeral replay results are linked but never
  conflated;
- generated action coverage is visible without high-cardinality metrics;
- a failing property identifies one command and one invariant, not merely a
  random seed;
- fixed catalog journeys remain simple and are not replaced by generated
  campaigns.

