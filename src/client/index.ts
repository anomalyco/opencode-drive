export { SimulationClient, SimulationError, connectSimulation } from "./client.js"
export { BackendSimulationClient, BackendSimulationError, connectBackendSimulation } from "./backend.js"
export type { BackendSimulationClientOptions } from "./backend.js"
export type { SimulationClientOptions } from "./client.js"
export const defaultPort = 40900
export const defaultBackendPort = 40950
export { Backend, Frontend, JsonRpc, SimulationProtocol } from "./protocol.js"
export type BackendFinishReason = import("./protocol.js").Backend.FinishReason
export type BackendItem = import("./protocol.js").Backend.Item
export type NetworkLogEntry = import("./protocol.js").Backend.NetworkLogEntry
export type OpenedExchange = import("./protocol.js").Backend.OpenedExchange
export type KeyModifiers = import("./protocol.js").Frontend.KeyModifiers
export type TraceList = import("./protocol.js").Frontend.TraceList
export type TraceRecord = import("./protocol.js").Frontend.TraceRecord
export type UiAction = import("./protocol.js").Frontend.Action
export type UiElement = import("./protocol.js").Frontend.Element
export type UiState = import("./protocol.js").Frontend.State
