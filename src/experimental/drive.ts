import { connectBackendSimulation, connectSimulation } from "../client/index.js"
import type { BackendSimulationClient, SimulationClient } from "../client/index.js"

export interface DriveEndpoints {
  readonly ui: string
  readonly backend: string
}

export interface DriveContext {
  readonly name: string
  readonly ui: SimulationClient
  readonly backend: BackendSimulationClient
  readonly artifacts: string
  readonly signal: AbortSignal
}

export type Driver = (context: DriveContext) => void | Promise<void>

export function defineDriver(driver: Driver) {
  return driver
}

export async function connectDrive(endpoints: DriveEndpoints, timeout = 30_000) {
  const ui = await connectSimulation({ url: endpoints.ui, timeout })
  const backend = await connectBackendSimulation({ url: endpoints.backend, timeout }).catch((error) => {
    ui.close()
    throw error
  })
  return {
    ui,
    backend,
    close() {
      ui.close()
      backend.close()
    },
  }
}
