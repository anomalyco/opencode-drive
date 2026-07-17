import { defineScript } from "../../src/index.js"
import * as Effect from "effect/Effect"

export default defineScript({
  launch: "manual",
  run: ({ server, clients, artifacts }) =>
    Effect.gen(function* () {
      yield* server.launch()
      const firstServer = Number(
        yield* Effect.tryPromise(() =>
          Bun.file(`${artifacts}/service.pid`).text(),
        ),
      )
      const [alice] = yield* Effect.all(
        [
          clients.launch("alice", { recording: true }),
          clients.launch("bob", { recording: true }),
        ],
        { concurrency: "unbounded" },
      )

      yield* server.kill()
      for (let attempt = 0; attempt < 100 && running(firstServer); attempt++)
        yield* Effect.sleep(10)
      if (running(firstServer))
        return yield* Effect.fail(new Error("the first server is still running"))

      yield* server.launch()
      const secondServer = Number(
        yield* Effect.tryPromise(() =>
          Bun.file(`${artifacts}/service.pid`).text(),
        ),
      )
      if (secondServer === firstServer)
        return yield* Effect.fail(new Error("the server was not relaunched"))

      const recording = alice.recording
      if (recording === undefined)
        return yield* Effect.fail(new Error("alice recording was not configured"))
      const aliceRecording = yield* recording.finish()
      yield* alice.close()
      const relaunchedAlice = yield* clients.launch("alice")
      yield* relaunchedAlice.close()
      yield* server.kill()

      yield* Effect.tryPromise(() =>
        Bun.write(
          `${artifacts}/kill-server-result.json`,
          JSON.stringify({ firstServer, secondServer, aliceRecording }),
        ),
      )
    }),
})

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
