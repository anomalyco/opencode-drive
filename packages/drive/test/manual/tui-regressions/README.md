# TUI regression probes

These scripts exercise real OpenCode TUI behavior against a compatible local checkout. They are deliberately excluded from the normal package test command: some are diagnostic probes for timing-sensitive bugs, and some encode desired behavior for known-open V2 issues and currently fail.

From the repository root, set `OPENCODE_DEV` to the checkout under test:

```sh
bun run --cwd packages/drive drive check test/manual/tui-regressions/interaction-lifecycle.ts
bun run --cwd packages/drive drive start --name tui-interaction-lifecycle \
  --script test/manual/tui-regressions/interaction-lifecycle.ts \
  --dev "$OPENCODE_DEV"
```

The interaction probe asserts that:

- A submitted message is visible before a delayed model response begins.
- An active streaming response reaches the interrupted state after Escape.

## Initial message hydration

[`anomalyco/opencode#35988`](https://github.com/anomalyco/opencode/issues/35988) reports that a new Session can permanently lose its first user row during pending/history hydration while retaining the assistant response. The black-box probe creates fresh TUIs and checks both transcript rows after the response:

```sh
OPENCODE_DRIVE_ATTEMPTS=20 bun run --cwd packages/drive drive start \
  --name tui-initial-message \
  --script test/manual/tui-regressions/initial-message-hydration.ts \
  --dev "$OPENCODE_DEV"
```

The natural race is uncommon. During diagnosis, a valid empty history snapshot was gated across input promotion; that deterministic Drive run failed against the pre-fix parent and passed against the fix in OpenCode PR #36433. The checked-in probe does not require test-only OpenCode instrumentation, so use more attempts when trying to reproduce naturally.

The restart probe opts into a file-backed database so the replacement service can recover the same durable Session:

```sh
bun run --cwd packages/drive drive check test/manual/tui-regressions/server-restart.ts
OPENCODE_DRIVE_DB=restart.sqlite \
  bun run --cwd packages/drive drive start --name tui-server-restart \
  --script test/manual/tui-regressions/server-restart.ts \
  --dev "$OPENCODE_DEV"
```

Relative database paths resolve under the isolated run's OpenCode data directory. The probe requires `OPENCODE_DRIVE_DB`, restarts the service while retaining the TUI, and asserts that the previous transcript rehydrates and accepts another prompt. Without the override Drive intentionally uses `:memory:`, so session loss across process replacement is expected.

## Pending form restart

[`anomalyco/opencode#36585`](https://github.com/anomalyco/opencode/issues/36585) reports that a form retained by the TUI becomes unanswerable after the replacement server loses its process-local form cache:

```sh
bun run --cwd packages/drive drive check test/manual/tui-regressions/pending-form-restart.ts
OPENCODE_DRIVE_DB=form-restart.sqlite bun run --cwd packages/drive drive start --name tui-pending-form-restart \
  --script test/manual/tui-regressions/pending-form-restart.ts \
  --dev "$OPENCODE_DEV"
```

Form state is process-local in current V2. This probe requires a file-backed
`OPENCODE_DRIVE_DB`, serves the model request made by durable restart recovery,
and verifies that the old question settles as interrupted, the stale form is
dismissed, the recovery continuation is projected, and the composer and terminal
settle without another user admission. It does not silently return as soon as the
old form disappears, leaving an unexpected recovery request unserved. Failures
retain the frame and projected messages in `state-machine-failure.json`.

Idle is not successful settlement: `Session.wait` waits for idleness even after a
failure. This probe also requires `Session.outcome` to be `succeeded` and the
recovery output to exist in durable assistant content.

## Reconnect outage

[`anomalyco/opencode#36688`](https://github.com/anomalyco/opencode/issues/36688) reports that a TUI exhausts its reconnect budget and crashes during a realistic post-update service outage:

```sh
OPENCODE_DRIVE_OUTAGE_MS=20000 bun run --cwd packages/drive drive start \
  --name tui-reconnect-outage \
  --script test/manual/tui-regressions/reconnect-outage.ts \
  --dev "$OPENCODE_DEV"
```

The desired invariant is that the TUI remains alive and returns to an actionable composer after the service relaunches. Current V2 passes with both 20-second and 60-second isolated outages. Increase the outage to model slower update election and cold location startup.

## Script-owned restart

Scripted TUIs connect explicitly to Drive's owned server endpoint, even without
network chaos. A retained TUI must not elect an unowned managed service while
`server.kill()` and `server.launch()` control replacement. The owned HTTP URL and
existing credential remain stable across generations; non-scripted live
launches keep their managed behavior.

The ownership probe holds replacement at a known ten-second boundary and
inspects registration without reading or printing credentials:

```sh
OPENCODE_DRIVE_RESTART_CYCLES=3 OPENCODE_DRIVE_RESTART_GATE_MS=10000 \
  bun run --cwd packages/drive drive start --daemon --name restart-ownership \
    --script test/manual/service-restart-ownership.ts \
    --dev "$OPENCODE_DEV"
```

It requires no competing registration while stopped, the retained SDK reaching
the explicitly launched replacement PID at the same URL, and a subsequent real
TUI reply. `quiescence-restart.ts` separately covers file-backed recovery and
terminal stability. An occupied owned port remains a visible boot failure; this
is not a generic port-retry policy.

## Tool transport death

`tool-transport-death.ts` is a one-shot Effect program, not a `defineScript`
module. `run` typechecks its fully provided program contract before execution:

```sh
OPENCODE_DEV="$OPENCODE_DEV" OPENCODE_DRIVE_MEDIA_DIR="$PWD/.drive-output" \
  bun run --cwd packages/drive drive run \
    test/manual/tui-regressions/tool-transport-death.ts
```

The internal scoped fixture routes one real static-tool HTTP connection through
Drive's existing TCP proxy. It establishes Core's event subscription before
progress, verifies the exact ephemeral `session.tool.progress` payload, and
drops the established connection. Running progress is not durable
`message.list` metadata. The native held-call interruption must arrive, a late
success must be rejected, exactly one tool part must settle in error, the model
must continue, and the terminal must become stable without another user prompt.

The probe no longer requires manually lowering controller idle timeouts or
removing the long-running `/execute` exemption. It does not synthesize a
cancellation result or change the public tool API. The invocation requires an
explicit `OPENCODE_DEV` so it cannot fall back to an installed service.

## Seeded lifecycle simulation

`lifecycle-properties.ts` uses the live OpenCode event stream and a queue-backed simulated response to select deterministic mid-flight actions. Submit, queued submit, text emission, reasoning emission, tool-input streaming, tool execution, completion, interruption, and provider disconnect are separate model transitions. A failure preserves its seed, action trace, model state, recent session events, and terminal frame in `state-machine-failure.json`:

```sh
OPENCODE_DRIVE_SEED=42 OPENCODE_DRIVE_STEPS=20 \
  bun run --cwd packages/drive drive start --name tui-lifecycle-properties \
  --script test/manual/tui-regressions/lifecycle-properties.ts \
  --dev "$OPENCODE_DEV"
```

Re-run a failure with the same seed and step count. Transition preconditions
constrain actions to valid idle, pending, streaming, tool-input, and running-tool
states. Tool input is chunked so interruption can occur before parsing completes;
advancing the response dispatches a blocking question tool so interruption can
also occur during execution. Interrupted tool parts must settle with an aborted
error in the server projection. A queued prompt must have exactly one owner
across pending input and projected history. Completion can promote it into the
next model Step; interruption can leave it awaiting resume.

`provider-disconnect-and-retry` injects one failure per logical Step, waits for
the actual `session.retry.scheduled` fact, and drives the replacement physical
attempt instead of waiting for terminal failure. Pre-output retry retains the
logical Step; incomplete-stream continuation may persist partial output across
assistant messages, so content assertions search the projected parts rather than
assuming one physical message. Queued input remains owned while recovery runs.
This case tests recovery, not retry-budget exhaustion, and its precondition makes
that limit explicit. Core's retry-policy tests cover exhaustion separately.

Text and reasoning emission now require a live delta from a complete single
burst while the stream remains open. They do not inject a later sentinel to
mask unbounded batching. Run against a V2 revision with the bounded stream-flush
fix; an older revision can correctly fail at this desired-behavior checkpoint.
Shared invariants also require the latest prompt and settled output to remain
visible, the server projection to retain the active prompt, the composer to
become actionable after terminal execution, and internal transport defects to
stay out of the UI.

Interruption uses the existing `llm.pending` simulation capability. If OpenCode rejects a response write after terminating the invocation, Drive confirms that the invocation is no longer pending and settles the response as externally terminated. If the invocation remains pending or the query fails, Drive preserves the original write failure.

## Network chaos properties

`network-properties.ts` runs a seeded state machine where user prompts and
network faults are transitions in one sequence. The script enables Drive's
`network` option, so the TUI is pinned to a chaos TCP proxy with `--server`:
latency windows, blackhole partitions, and connection kills degrade the HTTP
and SSE path while the Drive control plane stays clean. Prompts stream paced
replies so faults land mid-stream. Verification follows the liveness recipe:
heal the network, then require every outstanding prompt to converge on screen
and in the server projection, exactly once, with the composer actionable.
Connection kills are guarded away from in-flight prompt POSTs, whose rollback
is legitimate and covered deterministically by `test/manual/network-chaos.ts`
instead. A failure preserves seed, trace, model state, recent messages, and
the terminal frame in `state-machine-failure.json`:

```sh
OPENCODE_DRIVE_SEED=42 OPENCODE_DRIVE_STEPS=24 \
  bun run --cwd packages/drive drive start --name tui-network-properties \
  --script test/manual/tui-regressions/network-properties.ts \
  --dev "$OPENCODE_DEV"
```

The run prints coverage counters (kills, latency windows, blackholes, steers,
verifications); a seed that never exercised a fault class proved nothing about
it, so vary seeds until the counters cover what you care about. Every chosen
transition is also streamed to stderr as it runs, so a failed seed keeps its
trace even when the failure lands in the terminal verify phase (which writes
its own `state-machine-failure.json`).

## Type-during-submit input destruction

Seeds 1, 7, and 99 of `network-properties.ts` all reduced to one TUI bug: the
prompt component clears the composer only after the awaited `session.prompt`
POST resolves, so text typed during that in-flight window is appended to the
still-visible previous prompt, its enter is dropped, the post-await
`input.clear()` destroys it, and prompt history records a merged entry that
was never sent. `type-during-submit.ts` reproduces it deterministically by
widening the window with 800ms of proxy latency and typing 250ms after enter:

```sh
bun run --cwd packages/drive drive start --name tui-type-during-submit \
  --script test/manual/tui-regressions/type-during-submit.ts \
  --dev "$OPENCODE_DEV"
```

Companion probes that ruled out the other hypotheses: `steer-enter-drop.ts`
(steers at 0-1800ms into a clean-network stream are never dropped),
`heal-submit-drop.ts` (blackhole-heal-submit alone does not drop the prompt),
and `reconnect-modal-submit.ts` (asserts transport rejection in the current
`Connection lost` overlay, draft restoration in the actual composer, zero pending
and projected owners at a healed observation checkpoint, and exactly-once
successful settlement after explicit resend).

A refused connection can reject model preparation before any prompt POST is
attempted; this proves send-path rejection, not prompt-POST arrival. The TCP
probe samples both owners in the captured Session before Enter, and requires a
successful execution outcome afterward. It does not prove the absence of
arbitrarily delayed automatic resends beyond that checkpoint; causal retry
ordering belongs at the focused client/prompt admission seam.

With optimistic session creation (opencode PR #43687) the contract changed:
enter navigates immediately, the mid-flight typing lands in the live session
composer, and its enter submits, gated on the in-flight create. The probe now
asserts both prompts are admitted exactly once and in submission order. When
both are admitted before the run starts, opencode batches them into a single
turn, so only the LAST marker's reply appears on screen — admissions are the
ground truth, not done markers.

## Successful Outcome Guards

The recovery and resend probes require a successful execution outcome, not just
an idle Session with a visible completion marker. The pressure fixture runs those
actual probes with their model output followed by a terminal content filter:

```sh
OPENCODE_DRIVE_DB=guard-pressure.sqlite OPENCODE_DRIVE_GUARD_CASE=form \
  bun run --cwd packages/drive drive start --daemon --name form-outcome-guard \
    --script test/manual/probe-success-guards.ts --dev "$OPENCODE_DEV"
OPENCODE_DRIVE_GUARD_CASE=reconnect \
  bun run --cwd packages/drive drive start --daemon --name resend-outcome-guard \
    --script test/manual/probe-success-guards.ts --dev "$OPENCODE_DEV"
```

Both are **expected failures** at the successful-outcome assertion: the marker
can render and the terminal can settle even though `Session.outcome` is `failed`.
Keep these negative controls separate from ordinary gauntlet passes. The fixture
decorates only the model stream; it does not replace the production probe's
submission, recovery, or validation logic.

## Optimistic session creation

`optimistic-create.ts` encodes the desired shape for opencode issue #43563:
enter on the home screen must feel sent immediately even on a slow connection.
With 600ms of proxy latency it times how long the home wordmark survives the
enter press (pre-fix: two awaited round trips, ~1250ms; post-fix: ~35ms), then
asserts the optimistic prompt row is visible and that a follow-up prompt
submitted while the create is still in flight gates on it instead of failing.
`optimistic-create-failure.ts` covers the unwind: with connections refused,
enter must recover to the home screen with the draft restored in the
composer, an error toast, no phantom server session, and no ghost session
tab (a closed tab resurrected by a late lock-serialized registration write).

Both probes sleep 1.5s after ready before degrading the network: startup
catalog loads racing the chaos proxy trip the model-readiness guard and the
submit never reaches session creation.

## Compaction admission

`compact-admission.ts` exercises OpenCode PR #45973 through the production TUI
and real isolated server. A blackhole gates the TUI's model setup and admission
traffic; the clean SDK inspects durable history and can advance or cancel an
existing control item independently. Run each case separately at narrow and wide
sizes:

```sh
bun run --cwd packages/drive drive check test/manual/tui-regressions/compact-admission.ts
for scenario in ordered coalesce consumed cancelled rollback; do
  for cols in 70 120; do
    OPENCODE_DRIVE_MEDIA_DIR="$PWD/.drive-output" \
    OPENCODE_DRIVE_COMPACT_CASE="$scenario" OPENCODE_DRIVE_COLS="$cols" \
      bun run --cwd packages/drive drive start --daemon \
        --name "compact-$scenario-$cols" \
        --script test/manual/tui-regressions/compact-admission.ts \
        --dev "$OPENCODE_DEV" || exit 1
  done
done
```

`--daemon` keeps the script owner in the foreground so the loop observes its
completion and exit status. Successful runs print `verdict: "pass"`; failures
preserve their case, viewport, checkpoint trace, server events, messages, inbox,
and terminal frame in `state-machine-failure.json`.

| Case        | Invariant                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ordered`   | Render exactly one queued row during the partition, despite repeated gestures. Render a following prompt locally, then admit it exactly once after compaction.                                                   |
| `coalesce`  | An unseen server-side queued compaction replaces the speculative ID without a duplicate row. A following admission provides a send-chain barrier before checking reconciliation.                                 |
| `consumed`  | A known queued ID completes while model setup is blocked. Submit a fresh control ID after healing; with no new history it settles as `compaction.unavailable`, not a conflict, with no queued row remaining.     |
| `cancelled` | Cancellation removes the known pending item while setup is blocked. The client still proposes a fresh compaction ID and completes it after healing; cancellation itself does not permanently reserve the old ID. |
| `rollback`  | Killing connections before admission removes the unacknowledged row and displays the transport error. After healing, retry compaction and submit a recovery prompt successfully.                                 |

The simulated model paces a busy-step checkpoint before holding the response
open; this isolates admission behavior from stream-publication behavior. The
bounded-flush tests separately verify complete single bursts without a later
sentinel. Assertions distinguish durable admission from model execution,
including a legitimately unavailable second compaction.

This TCP-level probe checks queued checkpoints and settled convergence; it does
not establish continuous absence of transient rows, force every HTTP-response/SSE
permutation, or count raw mutation RPCs. OpenCode's
`packages/client/test/solid-compaction.test.ts` covers deferred-response
interleavings, positive pending-read acknowledgements, listener ownership, and
cross-session observation isolation.

## Open picker

`open-picker.ts` exercises OpenCode PR #45977 against a real isolated server and
the production TUI. SDK-created sessions exist before frontend launch, so the
initial picker cannot rely on open tabs or event-hydrated metadata. A second Git
project supplies a distinct placement target. Run each case at narrow and wide
sizes; repeat from fresh instances rather than carrying state between cases:

```sh
bun run --cwd packages/drive drive check test/manual/tui-regressions/open-picker.ts
for scenario in cold warm dispose selection deletion failure; do
  for cols in 44 100; do
    OPENCODE_DRIVE_MEDIA_DIR="$PWD/.drive-output" \
    OPENCODE_DRIVE_OPEN_CASE="$scenario" OPENCODE_DRIVE_COLS="$cols" \
      bun run --cwd packages/drive drive start --daemon \
        --name "open-picker-$scenario-$cols" \
        --script test/manual/tui-regressions/open-picker.ts \
        --dev "$OPENCODE_DEV" || exit 1
  done
done
```

| Case | Invariant |
| --- | --- |
| `cold` | With both reads blackholed, show an actionable loading shell instead of a false empty result; Escape dismisses it and healing does not reopen it. |
| `warm` | Retained cached-only rows remain selectable while blackholed; repeated Ctrl-O preserves the input and selected identity. A committed move received while dismissed must affect the local inherited location before any correcting GET can complete. |
| `dispose` | Disposing a pending refresh and reopening preserves the new filter and the latest retained row titles after healing. |
| `selection` | A newer recent row arriving during refresh does not change the selected session; a subsequent real prompt must be admitted into the intended session. |
| `deletion` | Observed server deletion removes the open row and the retained row used by a later blackholed opening. |
| `failure` | Failed reads report an inline error while retaining usable rows; healthy reopening clears the error and selection still targets the right session. |

The SDK and UI RPC channel stay clean; only TUI HTTP/SSE crosses the TCP proxy.
There is no selected-row semantic surface in `DialogSelect`, so the probe uses
real interactive row positions for keyboard navigation and verifies Enter's
destination through exactly-once prompt admission in the server projection.
Filtering may put a matching project before a session; the probe does not assume
an exact-title match must rank first. The movement case uses a later visible
rename as an ordered-SSE receipt barrier, then inspects the new-session footer
while blackholed and verifies the new Session's actual inherited placement after
healing.

Drive writes current V2 `cli.json` under its isolated `OPENCODE_CONFIG_DIR`.
The probe expresses `session.new_location: "inherit"` and a `Ctrl-N` binding
through `tuiConfig`, making the movement check an explicit fixture contract
without a manual config-file workaround or installed-client changes. Fixture
sessions also select the simulation model and build agent explicitly.

Successful runs write `open-picker-report.json` and print `passed: true`.
Failures retain the case, viewport, marker seed, checkpoint trace, server
sessions/messages, and terminal frame in `state-machine-failure.json`. The seed
labels prompts; this is a deterministic case suite, not randomized state-machine
coverage.

TCP-level checks do not force older/newer GET response order or independently
gate sessions and projects. OpenCode's production-component tests in
`packages/tui/test/app-lifecycle.test.tsx` and
`packages/tui/test/cli/tui/dialog-open.test.tsx` cover those exact read/event
interleavings, including deletion resurrection, movement during a read, uncached
moved rows, and filtered selection remaining visible after an overflowing
refresh. The Drive cases establish their stated checkpoints and convergence,
not continuous absence of transient rows.

## Probe helpers

`support.ts` collects the patterns these probes kept relearning: `serveMarkers`
(marker-routed fake model that picks the marker appearing *last* in the
request body — bodies carry the whole conversation), `pacedReply` (a ~2.5s
stream so faults land mid-flight), `appeared` (soft wait built on the
catchable `UiWaitTimeoutError`), `admissions` (server-side ground truth for
whether a submit landed), and `promptHistory` (parsed entries from the
instance's isolated home). Prefer these over reimplementing routing or
screen-scrape bookkeeping in new probes.

## Multi-tool interleavings

`multi-tool-interleavings.ts` launches shell, question, read, and glob calls in
one assistant step. Drive controls the declared shell by call ID from `run`,
holding it open while three permissions coexist,
approves the question so its form is hidden behind the remaining read and glob
permissions, and lets glob complete while read permission stays visible. It
then rejects read, answers the form, and releases shell last. Permission
rejection interrupts the whole assistant step after sibling tools settle, so
the probe submits a recovery prompt. It verifies mixed backend states,
settlement order, final projected tool states, post-interruption reuse, and
preserves terminal frames for both prompt-priority states:

```sh
bun run --cwd packages/drive drive check \
  test/manual/tui-regressions/multi-tool-interleavings.ts
bun run --cwd packages/drive drive start --name tui-multi-tool-interleavings \
  --script test/manual/tui-regressions/multi-tool-interleavings.ts \
  --dev "$OPENCODE_DEV"
```
