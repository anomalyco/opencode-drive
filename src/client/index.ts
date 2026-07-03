export { SimulationClient, SimulationError, connectSimulation } from "./client.js"
export { BackendSimulationClient, BackendSimulationError, connectBackendSimulation } from "./backend.js"
export type { BackendSimulationClientOptions } from "./backend.js"
export type { SimulationClientOptions } from "./client.js"
export { defaultBackendPort, defaultPort } from "./protocol.js"
export type {
  BackendFinishReason,
  BackendItem,
  BackendMethodName,
  BackendMethods,
  JsonRpcRequest,
  JsonRpcResponse,
  KeyModifiers,
  MethodName,
  Methods,
  NetworkLogEntry,
  OpenedExchange,
  TraceCleared,
  TraceList,
  TraceRecord,
  UiAction,
  UiElement,
  UiState,
} from "./protocol.js"
