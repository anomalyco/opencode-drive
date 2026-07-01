import { DateTime, Effect } from "effect"
import { Model } from "../latest/packages/schema/src/model.ts"
import { Project } from "../latest/packages/schema/src/project.ts"
import { Provider } from "../latest/packages/schema/src/provider.ts"
import { AbsolutePath } from "../latest/packages/schema/src/schema.ts"
import { Session } from "../latest/packages/schema/src/session.ts"

export interface ProbeData {
  readonly sessions: ReadonlyArray<typeof Session.Info.Type>
  readonly models: ReadonlyArray<typeof Model.Ref.Type>
}

export const generateProbeData = Effect.sync((): ProbeData => {
  const model = Model.Ref.make({ providerID: Provider.ID.make("opencode"), id: Model.ID.make("gpt-5.5") })
  return {
    models: [model],
    sessions: [
      Session.Info.make({
        id: Session.ID.make("ses_probe_00000000000000000000000000"),
        projectID: Project.ID.make("global"),
        title: "Probe session",
        model,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/probe") },
      }),
    ],
  }
})
