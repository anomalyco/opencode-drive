import { readdirSync } from "node:fs"
import { mkdir, symlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { Browser, Page } from "playwright-core"
import { discoverRegistration } from "../instance/discovery.js"
import { freePort } from "../instance/readiness.js"
import type * as OpenCodeInstance from "../instance/runtime.js"

export type Gui = Page

export interface GuiOptions {
  /**
   * Packaged Desktop app: a macOS `.app` bundle or the Desktop executable.
   * Defaults to the `--dev` checkout, or `/Applications/OpenCode.app` on macOS.
   */
  readonly app?: string
  /** Additional environment variables for Desktop. */
  readonly env?: Readonly<Record<string, string>>
  /** Startup deadline in milliseconds. */
  readonly timeout?: number
}

export class GuiLaunchError extends Schema.TaggedError<GuiLaunchError>()(
  "GuiLaunchError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface LaunchedGui {
  readonly gui: Gui
  /** Fails if Desktop exits while the script is running. */
  readonly failure: Effect.Effect<never, GuiLaunchError>
}

/** The packaged Desktop app to launch, or undefined when none is configured. */
export function packagedApp(options: GuiOptions = {}) {
  const app = options.app ?? (process.platform === "darwin" ? "/Applications/OpenCode.app" : undefined)
  return app === undefined ? undefined : resolve(app)
}

/**
 * The OpenCode CLI bundled with a packaged Desktop app. Drive serves with it
 * so Desktop finds a service of its own version and adopts it.
 */
export function bundledCli(app: string) {
  const resources = app.endsWith(".app")
    ? join(app, "Contents", "Resources")
    : process.platform === "darwin"
      ? join(dirname(app), "..", "Resources")
      : join(dirname(app), "resources")
  return join(resources, process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli")
}

/** Launches Desktop against the instance's running service and connects Playwright to it. */
export const launch = Effect.fn("OpenCodeGui.launch")(function* (
  instance: OpenCodeInstance.Instance,
  options: GuiOptions = {},
) {
  const timeout = options.timeout ?? 120_000
  const port = yield* freePort.pipe(
    Effect.flatMap((port) => (port === undefined ? Effect.fail("no free port") : Effect.succeed(port))),
    Effect.mapError((cause) => error("port", cause)),
  )
  const app = instance.dev === undefined ? packagedApp(options) : undefined
  if (instance.dev === undefined && app === undefined)
    return yield* new GuiLaunchError({ operation: "command", message: "GUI launch requires --dev or gui.app" })
  const command = app === undefined
    ? ["bun", "run", "dev:desktop"]
    : [yield* executable(app), `--remote-debugging-port=${port}`]
  const profile = yield* Effect.tryPromise({
    try: () => prepareProfile(instance),
    catch: (cause) => error("profile", cause),
  })
  const registration = yield* Effect.promise(() =>
    discoverRegistration(join(profile, "state")),
  )
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn(command, {
          cwd: instance.dev ?? instance.directory,
          env: {
            ...process.env,
            ...instance.environment,
            ...(registration?.version ? { OPENCODE_VERSION: registration.version } : {}),
            OPENCODE_DESKTOP_ISOLATED_SERVER: "0",
            OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(port),
            OPENCODE_DESKTOP_TEST_ROOT: profile,
            ...options.env,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        }),
      catch: (cause) => error("spawn", cause),
    }),
    (child) => Effect.promise(() => terminate(child)),
  )
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const exited = Effect.promise(async () => {
    const status = await child.exited
    const [stdout, stderr] = await output
    return error("exit", new Error(`Desktop exited with status ${status}\n\n${stdout}\n${stderr}`))
  }).pipe(Effect.flatMap(Effect.fail))
  const browser = yield* connect(port, timeout).pipe(Effect.raceFirst(exited))
  yield* Effect.addFinalizer(() => Effect.promise(() => browser.close().catch(() => undefined)))
  const gui = yield* waitForPage(browser, timeout).pipe(Effect.raceFirst(exited))
  return { gui, failure: exited } satisfies LaunchedGui
})

function executable(app: string) {
  return Effect.try({
    try: () => {
      if (!app.endsWith(".app")) return app
      const directory = join(app, "Contents", "MacOS")
      const [name] = readdirSync(directory)
      if (name === undefined) throw new Error(`No executable found in ${directory}`)
      return join(directory, name)
    },
    catch: (cause) => error("command", cause),
  })
}

// Desktop's test root redirects its profile and XDG directories. Pointing the
// XDG entries at the instance's directories lets Desktop discover Drive's service.
async function prepareProfile(instance: OpenCodeInstance.Instance) {
  const root = join(instance.artifacts, "desktop")
  await mkdir(root, { recursive: true })
  const env = instance.environment
  const links = {
    data: env.XDG_DATA_HOME,
    config: env.XDG_CONFIG_HOME,
    cache: env.XDG_CACHE_HOME,
    state: env.XDG_STATE_HOME,
  }
  for (const [name, target] of Object.entries(links)) {
    if (target === undefined) throw new Error(`Instance environment is missing ${name} directory`)
    await mkdir(target, { recursive: true })
    await symlink(target, join(root, name), "junction").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause
    })
  }
  return root
}

function connect(port: number, timeout: number) {
  return Effect.tryPromise({
    try: async (signal): Promise<Browser> => {
      const deadline = Date.now() + timeout
      while (!(await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false))) {
        signal.throwIfAborted()
        if (Date.now() >= deadline) throw new Error("Timed out waiting for Desktop remote debugging")
        await Bun.sleep(50)
      }
      // Loaded lazily so playwright-core is only required by GUI scripts.
      const packageName = "playwright-core"
      const { chromium } = await import(packageName)
      return chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    },
    catch: (cause) => error("connect", cause),
  })
}

function waitForPage(browser: Browser, timeout: number) {
  return Effect.tryPromise({
    try: async (signal) => {
      const deadline = Date.now() + timeout
      for (;;) {
        signal.throwIfAborted()
        const page = browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((page) => page.url().startsWith("http://localhost:") || page.url().startsWith("oc://"))
        if (page) {
          await page.locator("body").waitFor({ timeout: Math.max(0, deadline - Date.now()) })
          return page
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the Desktop window")
        await Bun.sleep(50)
      }
    },
    catch: (cause) => error("page", cause),
  })
}

async function terminate(child: Bun.Subprocess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/pid", String(child.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" }).exited
    return
  }
  // Desktop runs in its own process group so its Electron helpers stop with it.
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, name)
    } catch {}
  }
  signal("SIGTERM")
  await Promise.race([child.exited, Bun.sleep(5_000)])
  if (child.exitCode === null && child.signalCode === null) signal("SIGKILL")
}

function error(operation: string, cause: unknown) {
  return new GuiLaunchError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  })
}

export * as OpenCodeGui from "./gui.js"
