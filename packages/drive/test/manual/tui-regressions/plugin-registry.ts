import { rm } from "node:fs/promises";
import { Cause, Effect, Stream } from "effect";
import { defineScript, Llm } from "../../../src/index.js";

// Plugins register commands and tools; the probe checks that registry reads served to the
// frontend and to the model reflect activation, a runtime plugin addition, and a runtime removal
// without a server restart. Oracles are the SDK projection and the provider request body.
//
// Plugins live in the auto-discovered `.opencode/plugins/` directory rather than configured paths:
// configured local paths under a symlinked project root (macOS /var -> /private/var) are currently
// scanned under both spellings and fail activation with "Duplicate plugin ID".

const plugin = (name: string) => `export default {
  id: "${name}",
  async setup(ctx) {
    await ctx.command.transform((draft) =>
      draft.add({ name: "${name}-cmd", description: "${name} command", execute: async () => {} }),
    )
    await ctx.tool.transform((draft) =>
      draft.add({
        name: "${name}_tool",
        description: "${name} tool",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async () => ({ content: "${name}" }),
      }),
    )
  },
}
`;

export default defineScript({
  project: {
    files: { ".opencode/plugins/alpha/index.ts": plugin("alpha") },
  },
  run: ({ ui, llm, opencode, artifacts, fs }) =>
    Effect.gen(function* () {
      const location = yield* opencode.location.get({
        location: { directory: `${artifacts}/files` },
      });
      const bodies: string[] = [];
      yield* llm.serve((request, index) => {
        bodies.push(JSON.stringify(request.body));
        return Stream.make(Llm.text(`reply-${index + 1}`));
      });

      const until = <A>(
        label: string,
        read: Effect.Effect<A, unknown>,
        ready: (value: A) => boolean,
      ) =>
        Effect.gen(function* () {
          const deadline = Date.now() + 20_000;
          while (true) {
            const value = yield* read.pipe(
              Effect.tapError((error) =>
                Effect.sync(() =>
                  console.error(`${label}: read failed`, error),
                ),
              ),
              Effect.orDie,
            );
            if (ready(value)) return value;
            if (Date.now() > deadline)
              return yield* Effect.fail(new Error(`timed out: ${label}`));
            yield* Effect.sleep("50 millis");
          }
        });
      const commands = opencode.command
        .list({ location })
        .pipe(Effect.map((result) => result.data.map((c) => c.name)));
      const activePlugins = opencode.plugin
        .list({ location })
        .pipe(
          Effect.map((result) =>
            result.data
              .filter((plugin) => plugin.state.status === "active")
              .map((plugin) => String(plugin.id)),
          ),
        );
      const expectPlugins = (
        present: readonly string[],
        missing: readonly string[],
      ) =>
        until(
          `plugins ${present.join(",")} without ${missing.join(",") || "-"}`,
          activePlugins,
          (ids) =>
            present.every((id) => ids.includes(id)) &&
            missing.every((id) => !ids.includes(id)),
        );
      const requestTools = (prompt: string) =>
        Effect.gen(function* () {
          const before = bodies.length;
          yield* ui.submit(prompt);
          yield* ui.waitFor(`reply-${before + 1}`, { timeout: 15_000 });
          const body = bodies[before];
          if (!body)
            return yield* Effect.fail(
              new Error(`no model request captured for ${prompt}`),
            );
          return { has: (tool: string) => body.includes(`"${tool}"`) };
        });
      const expectCommands = (
        present: readonly string[],
        missing: readonly string[],
      ) =>
        Effect.gen(function* () {
          const names = yield* until(
            `commands ${present.join(",")} without ${missing.join(",") || "-"}`,
            commands,
            (names) =>
              present.every((n) => names.includes(n)) &&
              missing.every((n) => !names.includes(n)),
          );
          return names;
        });
      const expectTools = (
        prompt: string,
        present: readonly string[],
        missing: readonly string[],
      ) =>
        Effect.gen(function* () {
          const tools = yield* requestTools(prompt);
          for (const tool of present)
            if (!tools.has(tool))
              return yield* Effect.fail(
                new Error(`${prompt}: model request lacks ${tool}`),
              );
          for (const tool of missing)
            if (tools.has(tool))
              return yield* Effect.fail(
                new Error(`${prompt}: model request still has ${tool}`),
              );
        });

      // Phase 1: cold start with alpha configured.
      yield* expectPlugins(["alpha"], ["beta"]);
      yield* expectCommands(["alpha-cmd"], ["beta-cmd"]);
      yield* expectTools(
        "first-request-after-activation",
        ["alpha_tool"],
        ["beta_tool"],
      );
      yield* ui.press("u", { ctrl: true });
      yield* ui.type("/alpha");
      yield* ui.waitFor("alpha-cmd", { timeout: 5_000 }).pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            const frame = (yield* ui.capture()) as {
              lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }>;
            };
            const text = frame.lines.map((line) =>
              line.spans
                .map((span) => span.text)
                .join("")
                .trimEnd(),
            );
            console.error(
              "slash menu frame:\n" +
                text.filter((line) => line.trim()).join("\n"),
            );
          }),
        ),
      );
      yield* ui.press("escape");
      yield* ui.press("u", { ctrl: true });

      // Phase 2: add beta by writing a plugin into the discovered directory; no restart.
      yield* fs.writeFile(".opencode/plugins/beta/index.ts", plugin("beta"));
      yield* expectPlugins(["alpha", "beta"], []);
      yield* expectCommands(["alpha-cmd", "beta-cmd"], []);
      yield* expectTools(
        "request-after-adding-beta",
        ["alpha_tool", "beta_tool"],
        [],
      );

      // Phase 3: remove beta again.
      yield* Effect.promise(() =>
        rm(`${artifacts}/files/.opencode/plugins/beta`, {
          recursive: true,
          force: true,
        }),
      );
      // Command visibility doubles as the activation barrier: it appears only once alpha's setup ran.
      yield* expectPlugins(["alpha"], ["beta"]);
      yield* expectCommands(["alpha-cmd"], ["beta-cmd"]);
      yield* expectTools(
        "request-after-removing-beta",
        ["alpha_tool"],
        ["beta_tool"],
      );

      console.log(JSON.stringify({ requests: bodies.length }));
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() =>
          console.error("plugin-registry failed:", Cause.pretty(cause)),
        ),
      ),
    ),
});
