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

  test("uses Effect CLI validation for command options", async () => {
    const root = await temporary()
    const invalidConnect = spawn(["send", "--seed", "10"], root)
    const invalidConcurrency = spawn(["start", "--campaign", fixture("campaign.ts"), "--concurrency", "0"], root)
    const invalidModes = spawn(["start", "--driver", fixture("driver.ts"), "--command.render"], root)
    const invalidDevCommand = spawn(["start", "--dev", "/tmp/opencode", "--", "opencode2"], root)
    expect(await invalidConnect.exited).toBe(1)
    expect(await invalidConcurrency.exited).toBe(1)
    expect(await invalidModes.exited).toBe(1)
    expect(await invalidDevCommand.exited).toBe(1)
  })

  test("runs a visible instance and executes an ordered command batch", async () => {
    const root = await temporary()
    roots.push(join(tmpdir(), "opencode-drive", "command-test"))
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
    const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    expect(status).toBe(0)
    const result = JSON.parse(stdout) as { readonly results: ReadonlyArray<{ readonly result: { readonly screen: string } }> }
    expect(result.results).toHaveLength(3)
    expect(result.results[2]?.result.screen).toContain("hello\n[enter]")
    const state = join(tmpdir(), "opencode-drive", "command-test", "state")
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
    roots.push(join(tmpdir(), "opencode-drive", "external-test"))
    const running = spawn([
      "start",
      "--name",
      "external-test",
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ], root)
    try {
      await waitFor(join(root, "registry", "external-test.json"))
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
      expect(stdout).toContain("connected")
    } finally {
      running.kill("SIGINT")
      await running.exited
    }
  })

  test("starts detached and accepts later commands", async () => {
    const root = await temporary()
    const artifacts = join(tmpdir(), "opencode-drive", "detached-test")
    roots.push(artifacts)
    const started = spawn([
      "start",
      "--name",
      "detached-test",
      "--",
      process.execPath,
      fixture("fake-opencode.ts"),
    ], root)
    expect(await started.exited).toBe(0)

    const command = spawn(["send", "--name", "detached-test", "--command.render"], root)
    const [status, stdout] = await Promise.all([command.exited, new Response(command.stdout).text()])
    expect(status).toBe(0)
    expect(stdout).toContain("Fake OpenCode")

    const manifest = await Bun.file(join(root, "registry", "detached-test.json")).json()
    process.kill(manifest.pid, "SIGTERM")
  })

  test("runs a default-exported TypeScript driver", async () => {
    const root = await temporary()
    const artifacts = join(tmpdir(), "opencode-drive", "driver-test")
    roots.push(artifacts)
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
    expect(await child.exited).toBe(0)
    const result = await Bun.file(join(artifacts, "driver-result.json")).json()
    expect(result.screen).toContain("driver-text")
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
