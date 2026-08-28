# opencode-drive

## 2.0.0

### Major Changes

- 04013ce: Update Drive to the current OpenCode V2 client (`0.0.0-dev-18535`) and its
  matching Effect V4 stack (`4.0.0-rc.112`). Effect is now an exact peer dependency
  so consumer programs and Drive share the same Effect types and runtime.
  The client, protocol, schema, platform, and test packages use the same
  coherent `rc.112` stack.

  Migrate schema-backed errors and RPC JSON codecs, and preserve optional CLI
  boolean flags with explicit false defaults. Static tool adapters now emit
  native V2 progress metadata, result metadata, and `Tool.Error` failures.

  Dynamic tool controls follow the current V2 protocol: change
  `invocation.progress({ structured: { phase: "searching" } })` to
  `invocation.progress({ phase: "searching" })`, and read the model call ID from
  `invocation.context.id` instead of `invocation.context.callID`.
  `finish({ structured, content })` and LLM queue/send/serve/title sequencing,
  cancellation, reconnection, supervision, and settlement retain their contracts.

### Minor Changes

- 6e16c14: Add an opt-in KeyCastr-style overlay for semantic key presses in screenshots and recording exports.
- b02239e: Add a controllable chaos network proxy between launched TUIs and the OpenCode server, plus configurable simulated-LLM timeouts.

  Enabling the new `network` option (on `defineScript`, driver options, and instance options) routes every launched TUI through a chaos TCP proxy: TUIs connect with an explicit `--server` pinned to the proxy and authenticate through the registered service password, so reconnects always cross the proxy, the TUI never elects a replacement server, and the drive control plane plus the driver's SDK client stay unaffected. Scripts and drivers control conditions through the new `network` capability: `set({ latencyMs, jitterMs, refuseNew, blackhole })` (replace-whole-state semantics), `clear()`, `killConnections()`, and `connections()`. The proxy resolves its upstream lazily from the service registration, so it follows server restarts that change ports.

  The new `llm` option (`requestTimeout`, `settlementTimeout`) surfaces the existing LLM controller timeouts for scenarios that intentionally hold responses open longer than the 30s defaults.

- 56c42f5: Annotated recording exports. `tui.recording.mark(label)` labels the current instant during a recorded run; marks become a burned-in footer in the exported video (segment label bottom-left, elapsed timecode and "drive" branding bottom-right). `exportRecording` gains `footer`, `annotations`, and `clips` options — clips trim, re-speed (`speed`), and freeze (`holdMs`) segments of the raw timeline, concatenated in order. `SampledFrame` now carries `sourceAtMs` (raw timeline time before trim/rebase) alongside the exported `atMs`.
- b7ddb73: Split wait deadlines from control-plane timeouts. `ui.waitFor`, `ui.getElement`, and `ui.getNode` now fail with the new catchable `UiWaitTimeoutError` when their deadline passes, so scripts can branch on "did X appear in time?" (for example with `Effect.catchTag("UiWaitTimeoutError", ...)`). `UiTimeoutError` is reserved for unanswered UI RPCs — an unresponsive control plane — and remains fatal to script runs even when caught.

### Patch Changes

- 97d65df: A served or queued LLM response whose backend detaches mid-stream (for example `server.kill()` while a reply is streaming) is now abandoned instead of recorded as a controller failure. Previously the interrupt-only cause poisoned the run with a phantom `LlmControllerError: All fibers interrupted without error`, making restart scenarios impossible to script.
- c591d43: Fix two controlled-tool transport defects: `/execute` requests are exempt from Bun's idle timeout (a silent controlled tool no longer has its transport killed at the 255s ceiling), and plugin tool results no longer carry an `output` value, which opencode's tool runtime rejects for tools that declare no output schema.

## 1.4.5

### Patch Changes

- 74caec8: Resolve screenshot output directories directly from the active instance registry while retaining compatibility with already-running older instances.

## 1.4.4

### Patch Changes

- 30cbc47: Render screenshots locally from captured terminal frames instead of requiring OpenCode to own PNG rendering.
- 3d451b5: Deliver named arrows and modified special keys through terminal escape sequences,
  and reject unsupported UI command parameters instead of silently dropping them.
- 72cc762: Support current OpenCode V2 development checkouts and reject checkouts without simulation support.

## 1.4.3

### Patch Changes

- 99561ad: Restore controlled tools against the current V2 plugin API and add typed runtime control for write calls.

## 1.4.2

### Patch Changes

- b524213: Render light box-drawing borders as continuous geometric primitives.
- a24a09d: Defer recording font initialization so source-checkout scripts can start without loading a duplicate renderer.

## 1.4.1

### Patch Changes

- 6a8d52b: Prevent concurrent detached launchers from stealing prepared instance ownership and spawning competing daemon processes.
- d71356f: Restore compatibility with current OpenCode V2 checkouts and packed Drive installations. Drive now uses V2's built-in simulation transport and provider shape, isolates scripted service ports and command forms, and compiles standalone scripts against the launching Drive toolchain without package installation or source-directory links.

## 1.4.0

### Minor Changes

- c20d147: Control arbitrary provider-backed tool lifecycles with dynamic registration, structured progress, success, failure, cancellation, and reconnect-safe replay.

## 1.3.0

### Minor Changes

- 7caebeb: Expose semantic UI snapshots, exact semantic node polling, and safe semantic-node clicks for compatible OpenCode endpoints.

## 1.2.0

### Minor Changes

- 4e0c002: Write screenshots and recordings beneath run- and restart-scoped media directories so named outputs cannot overwrite earlier runs.

## 1.1.0

### Minor Changes

- fad9f96: Allow scripts and library drivers to intercept declared tools and control concurrent invocations by call ID at runtime.

### Patch Changes

- 63d3464: Keep service and progress output out of visible TUI sessions and avoid reinstalling the OpenTUI preload package for development checkouts.
- fd45cfe: Allow Drive runs to select a durable OpenCode database with the Effect-configured `OPENCODE_DRIVE_DB` setting while retaining `:memory:` as the default.
- e66adc1: Preserve recorded frame timing during MP4 encoding and reduce work for dense or unchanged terminal output.
- e7dff5f: Render diagonal quadrant block glyphs as exact terminal cell geometry in screenshots, recordings, and catalog frames.
- 63d3464: Export recordings at 60 FPS by default and preserve the requested frame rate in generated MP4 files.

## 1.0.0

### Major Changes

- 1009394: Remove the Promise-based simulation clients. `SimulationClient`, `BackendSimulationClient`, `connectSimulation`, and `connectBackendSimulation` are gone, along with the `opencode-drive/experimental` entry point. The `opencode-drive/client` entry now exports only the canonical protocol schemas and default ports; the public API is Effect-only, as documented. The CLI drives instances through the Effect `SimulationConnector` directly.

### Minor Changes

- 9deab8d: Add the browser-safe `opencode-drive/frame` entry point: canonical cell geometry, OpenTUI text-attribute bits, the geometric block/bar glyph table, and baseline placement shared by the Drive PNG renderer and downstream canvas renderers. The PNG renderer now also draws the `┃` and `╹` structural bars geometrically instead of with fonts.

### Patch Changes

- 8481090: Settle simulated LLM responses cleanly when OpenCode terminates an invocation during interruption. Drive now uses the negotiated `llm.pending` capability to distinguish external termination from genuine response write failures.

## 0.6.0

### Minor Changes

- 58c4801: Return simulated background shells immediately, continue their handlers asynchronously, notify the session when they finish, and cancel them when Drive shuts down.
- b5e8dfe: Make the script API Effect-only. Script setup and run callbacks, UI, LLM, filesystem, server, and TUI operations now return Effects; LLM serve handlers return Streams; and script cancellation uses Effect interruption without a Promise compatibility shim.
- 775f799: Remove the tool handler `AbortSignal`. Foreground session interruption, transport disconnects, and Drive shutdown now surface uniformly as Effect interruption, and controller shutdown awaits handler finalizers. Detached background shell handlers remain active after launch and are interrupted during Drive shutdown.
- 8e51796: Add deterministic shell, web fetch, and web search handlers with progress, success, failure, and interruption simulation.
- 905f846: Add `opencode-drive script init` for generating an Effect-native starter script and show focused migration guidance when `check` finds Promise-style script callbacks.
- d1bba54: Add first-class tool call input streaming through `Llm.toolCall` stream options.
- 72f7aff: Expose the authenticated generated OpenCode SDK as `opencode` to drivers and scripts.
- 37b4cd1: Give capabilities precise typed errors, validate UI predicates in canonical `ui.waitFor`, expose concrete failures through `Errors`, and keep pure response constructors exclusively under `Llm`.
- 13ec474: Unify the Effect driver and `defineScript` around one canonical programmatic model. Both expose the generated SDK as `opencode`, the primary frontend as `tui`, additional frontends through `tuis`, and the primary UI as `ui`. Every `Tui` has the same `{ ui, close, recording }` shape and `{ recording, viewport }` options. Project setup now uses the shared `Project`, `Setup`, `SetupContext`, and `ProjectFileSystem` types. Remove duplicate script UI types, flattened frontend handles, partial settlement controls, root-level raw simulation exports, convenience CLI aliases, and the `wait` helper.

### Patch Changes

- c8f5b51: Attach one best-effort normalized terminal frame to UI polling timeout errors without retaining screenshot artifacts.
- c8f5b51: Render OpenCode's full UI symbol set with deterministic bundled fallback fonts instead of platform fonts or hand-drawn symbol exceptions.
- c8f5b51: Preserve the managed driver's `Scope.Scope` requirement when consumed from TypeScript workspace applications.
- 40d2241: Render the background completion arrow correctly in exported recordings.
- 11cbbfd: Preserve the canonical OpenCode UI command shapes for optional named screenshots and key presses.
