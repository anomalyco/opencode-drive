import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("opencode-drive", () => {
  test("connects to the default ports when name is omitted", async () => {
    const root = await temporary()
    const child = spawn(["send"], root)
    const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      name: "default",
      endpoints: {
        ui: "ws://127.0.0.1:40900",
        backend: "ws://127.0.0.1:40950",
      },
    })
  })

  test("uses default for unnamed starts and rejects a duplicate", async () => {
    const root = await temporary()
    const started = spawn(["start", "--", process.execPath, fixture("fake-opencode.ts")], root)
    expect(await started.exited).toBe(0)
    const file = join(root, "registry", "default.json")
    const manifest = await Bun.file(file).json()
    roots.push(manifest.artifacts)
    expect(manifest.name).toBe("default")
    expect(manifest.artifacts).toMatch(/\/default-[a-f0-9]{6}$/)

    const described = spawn(["describe"], root)
    const [describeStatus, description] = await Promise.all([
      described.exited,
      new Response(described.stdout).text(),
    ])
    expect(describeStatus).toBe(0)
    expect(description).toBe([
      `PID: ${manifest.pid}`,
      "Headless: true",
      `Artifacts: ${manifest.artifacts}`,
      `UI: ${manifest.endpoints.ui}`,
      `Backend: ${manifest.endpoints.backend}`,
      `Logs: ${join(manifest.artifacts, "home", ".local", "share", "opencode", "log", "opencode*.log")}`,
      "",
    ].join("\n"))

    const command = spawn(["send", "--command.state"], root)
    const [commandStatus, stdout] = await Promise.all([command.exited, new Response(command.stdout).text()])
    expect(commandStatus).toBe(0)
    expect(JSON.parse(stdout).focused.editor).toBe(true)

    const duplicate = spawn(["start", "--", process.execPath, fixture("fake-opencode.ts")], root)
    const [duplicateStatus, stderr] = await Promise.all([duplicate.exited, new Response(duplicate.stderr).text()])
    expect(duplicateStatus).toBe(1)
    expect(stderr).toContain('drive instance "default" is already running')
    process.kill(manifest.pid, "SIGTERM")
  })

  test("uses Effect CLI validation for command options", async () => {
    const root = await temporary()
    const invalidConnect = spawn(["send", "--seed", "10"], root)
    const invalidConcurrency = spawn(["start", "--campaign", fixture("campaign.ts"), "--concurrency", "0"], root)
    const invalidModes = spawn(["start", "--driver", fixture("driver.ts"), "--command.state"], root)
    const invalidDevCommand = spawn(["start", "--dev", "/tmp/opencode", "--", "opencode2"], root)
    expect(await invalidConnect.exited).toBe(1)
    expect(await invalidConcurrency.exited).toBe(1)
    expect(await invalidModes.exited).toBe(1)
    expect(await invalidDevCommand.exited).toBe(1)
  })

  test("runs a visible instance and executes an ordered command batch", async () => {
    const root = await temporary()
    const child = spawn([
      "start",
      "--name",
      "command-test",
      "--visible",
      "--command.type",
      "hello",
      "--command.press",
      "enter",
      "--command.render",
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ], root)
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status).toBe(0)
    expect(stdout).toBe("success\n")
    const state = join(artifactPath(stderr), "state")
    roots.push(resolve(state, ".."))
    expect(await readdir(state)).toEqual(["files"])
    expect(await readdir(join(state, "files", ".git"))).toEqual([])
    expect(await Bun.file(join(state, "files", ".opencode", "opencode.jsonc")).json()).toMatchObject({
      model: "simulation/sim-model",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      providers: { simulation: { models: { "sim-model": { name: "Simulated Model" } } } },
    })
  })

  test("connects repeatedly to a foreground named instance", async () => {
    const root = await temporary()
    const running = spawn([
      "start",
      "--name",
      "external-test",
      "--visible",
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ], root)
    try {
      await waitFor(join(root, "registry", "external-test.json"))
      const manifest = await Bun.file(join(root, "registry", "external-test.json")).json()
      roots.push(manifest.artifacts)
      const command = spawn([
        "send",
        "--name",
        "external-test",
        "--command.type",
        "connected",
        "--command.render",
      ], root)
      const [status, stdout] = await Promise.all([command.exited, new Response(command.stdout).text()])
      expect(status).toBe(0)
      expect(stdout).toBe("success\n")
    } finally {
      running.kill("SIGINT")
      await running.exited
    }
  })

  test("removes a visible instance manifest when the process exits", async () => {
    const root = await temporary()
    const child = spawn([
      "start",
      "--name",
      "visible-exit-test",
      "--visible",
      "--",
      process.execPath,
      "-e",
      "process.exit(0)",
    ], root)
    expect(await child.exited).toBe(0)
    expect(await Bun.file(join(root, "registry", "visible-exit-test.json")).exists()).toBe(false)
  })

  test("starts detached and accepts later commands", async () => {
    const root = await temporary()
    const started = spawn([
      "start",
      "--name",
      "detached-test",
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ], root)
    expect(await started.exited).toBe(0)

    const command = spawn(["send", "--name", "detached-test", "--command.state"], root)
    const [status, stdout] = await Promise.all([command.exited, new Response(command.stdout).text()])
    expect(status).toBe(0)
    expect(JSON.parse(stdout).focused.editor).toBe(true)

    const render = spawn(["send", "--name", "detached-test", "--command.render"], root)
    const [renderStatus, renderOutput] = await Promise.all([render.exited, new Response(render.stdout).text()])
    expect(renderStatus).toBe(0)
    expect(renderOutput).toBe("/tmp/opencode-drive-fake/screenshot.png\n")

    const record = spawn(["send", "--name", "detached-test", "--command.start-record"], root)
    const [recordStatus, recordOutput] = await Promise.all([record.exited, new Response(record.stdout).text()])
    expect(recordStatus).toBe(0)
    expect(JSON.parse(recordOutput)).toEqual({ recording: true })

    const endRecord = spawn(["send", "--name", "detached-test", "--command.end-record"], root)
    const [endRecordStatus, endRecordOutput] = await Promise.all([endRecord.exited, new Response(endRecord.stdout).text()])
    expect(endRecordStatus).toBe(0)
    expect(endRecordOutput).toBe("/tmp/opencode-drive-fake/recording.gif\n")

    const manifest = await Bun.file(join(root, "registry", "detached-test.json")).json()
    roots.push(manifest.artifacts)
    process.kill(manifest.pid, "SIGTERM")
  })

  test("keeps a detached headless manifest when the process exits", async () => {
    const root = await temporary()
    const started = spawn([
      "start",
      "--name",
      "headless-exit-test",
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ], root)
    expect(await started.exited).toBe(0)
    const file = join(root, "registry", "headless-exit-test.json")
    const manifest = await Bun.file(file).json()
    roots.push(manifest.artifacts)
    process.kill(manifest.pid, "SIGTERM")
    await waitForExit(manifest.pid)
    expect(await Bun.file(file).exists()).toBe(true)
  })

  test("prints pending LLM exchanges as JSON", async () => {
    const root = await temporary()
    const running = spawn([
      "start",
      "--name",
      "pending-test",
      "--visible",
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ], root)
    try {
      await waitFor(join(root, "registry", "pending-test.json"))
      const manifest = await Bun.file(join(root, "registry", "pending-test.json")).json()
      roots.push(manifest.artifacts)
      const command = spawn(["send", "--name", "pending-test", "--command.llm.pending"], root)
      const [status, stdout] = await Promise.all([command.exited, new Response(command.stdout).text()])
      expect(status).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ exchanges: [] })
    } finally {
      running.kill("SIGINT")
      await running.exited
    }
  })

  test("runs a default-exported TypeScript driver", async () => {
    const root = await temporary()
    const child = spawn([
      "start",
      "--name",
      "driver-test",
      "--driver",
      fixture("driver.ts"),
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ], root)
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(status).toBe(0)
    const artifacts = artifactPath(stderr)
    roots.push(artifacts)
    const result = await Bun.file(join(artifacts, "driver-result.json")).json()
    expect(result.focused.editor).toBe(true)
  })

  test("runs fresh campaign cases and writes a summary", async () => {
    const root = await temporary()
    const out = join(root, "campaign")
    const campaign = spawn([
      "start",
      "--campaign",
      fixture("campaign.ts"),
      "--seed",
      "100",
      "--count",
      "2",
      "--concurrency",
      "2",
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ], root)
    const status = await campaign.exited
    expect(status).toBe(0)
    const summary = await Bun.file(join(out, "summary.json")).json()
    expect(summary).toMatchObject({ count: 2, passed: 2, failed: 0 })
    expect(await Bun.file(join(out, "case-000000-100", "flow.json")).exists()).toBe(true)
    expect(await Bun.file(join(out, "case-000001-101", "flow.json")).exists()).toBe(true)
  }, 30_000)
})

function spawn(args: ReadonlyArray<string>, root: string) {
  return Bun.spawn([process.execPath, resolve("src/cli/index.ts"), ...args], {
    cwd: resolve("."),
    env: {
      ...process.env,
      DRIVE_REGISTRY_DIR: join(root, "registry"),
      DRIVE_CAMPAIGN_ROOT: join(root, "campaign"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

function fixture(name: string) {
  return resolve("test", "fixtures", name)
}

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "opencode-drive-test-"))
  roots.push(root)
  return root
}

async function waitFor(file: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${file}`)
}

async function waitForExit(pid: number) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await Bun.sleep(25)
    } catch {
      return
    }
  }
  throw new Error(`timed out waiting for process ${pid} to exit`)
}

function artifactPath(stderr: string) {
  const line = stderr.split("\n").find((value) => value.startsWith("opencode-drive: artifacts "))
  if (!line) throw new Error("artifact path was not reported")
  return line.slice("opencode-drive: artifacts ".length)
}
