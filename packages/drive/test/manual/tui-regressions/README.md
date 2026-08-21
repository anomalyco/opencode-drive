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
bun run --cwd packages/drive drive start --name tui-pending-form-restart \
  --script test/manual/tui-regressions/pending-form-restart.ts \
  --dev "$OPENCODE_DEV"
```

The desired invariant is that the form either remains answerable or is dismissed as stale. If a retained form accepts local input but submission returns `Form not found`, the probe fails and preserves `stale-form.frame.json`. Current V2 dismisses the stale form and passes this probe.

## Reconnect outage

[`anomalyco/opencode#36688`](https://github.com/anomalyco/opencode/issues/36688) reports that a TUI exhausts its reconnect budget and crashes during a realistic post-update service outage:

```sh
OPENCODE_DRIVE_OUTAGE_MS=20000 bun run --cwd packages/drive drive start \
  --name tui-reconnect-outage \
  --script test/manual/tui-regressions/reconnect-outage.ts \
  --dev "$OPENCODE_DEV"
```

The desired invariant is that the TUI remains alive and returns to an actionable composer after the service relaunches. Current V2 passes with both 20-second and 60-second isolated outages. Increase the outage to model slower update election and cold location startup.

## Seeded lifecycle simulation

`lifecycle-properties.ts` uses the live OpenCode event stream and a queue-backed simulated response to select deterministic mid-flight actions. Submit, queued submit, text emission, reasoning emission, tool-input streaming, tool execution, completion, interruption, and provider disconnect are separate model transitions. A failure preserves its seed, action trace, model state, recent session events, and terminal frame in `state-machine-failure.json`:

```sh
OPENCODE_DRIVE_SEED=42 OPENCODE_DRIVE_STEPS=20 \
  bun run --cwd packages/drive drive start --name tui-lifecycle-properties \
  --script test/manual/tui-regressions/lifecycle-properties.ts \
  --dev "$OPENCODE_DEV"
```

Re-run a failure with the same seed and step count. Transition preconditions constrain actions to valid idle, pending, streaming, tool-input, and running-tool states. Tool input is chunked so interruption can occur before parsing completes; advancing the tool response dispatches a blocking question tool so interruption can also occur during execution. Interrupted tool parts must settle with an aborted error in the server projection. A queued prompt must have exactly one owner across pending input and projected history. Completion can promote it into the next model step, interruption can leave it awaiting resume, and provider failure can promote it into a replacement execution. Shared invariants also require the latest prompt and settled output to remain visible, the server projection to retain the active prompt, the composer to become actionable after terminal execution, and internal transport defects to stay out of the UI.

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
and `reconnect-modal-submit.ts` (classifies submits into the reconnect
overlay).

With optimistic session creation (opencode PR #43687) the contract changed:
enter navigates immediately, the mid-flight typing lands in the live session
composer, and its enter submits, gated on the in-flight create. The probe now
asserts both prompts are admitted exactly once and in submission order. When
both are admitted before the run starts, opencode batches them into a single
turn, so only the LAST marker's reply appears on screen — admissions are the
ground truth, not done markers.

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
