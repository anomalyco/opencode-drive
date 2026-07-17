import type { Backend } from "../simulation/protocol.js"

export { SimulationClient, SimulationError, connectSimulation } from "./client.js"
export { BackendSimulationClient, BackendSimulationError, connectBackendSimulation } from "./backend.js"
export type { BackendSimulationClientOptions } from "./backend.js"
export type { SimulationClientOptions } from "./client.js"
export const defaultPort = 40900
export const defaultBackendPort = 40950
export { Backend, Frontend, JsonRpc, SimulationProtocol } from "./protocol.js"
export type BackendFinishReason = Backend.FinishReason
export type BackendItem = Backend.Item
export type OpenedExchange = Backend.OpenedExchange
export type {
  UiAction,
  UiElement,
  UiKeyModifiers as KeyModifiers,
  UiState,
} from "../script/types.js"
