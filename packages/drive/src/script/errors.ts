import * as Schema from "effect/Schema"
import { RpcClientError as RpcClientErrors } from "effect/unstable/rpc"

export const RpcClientError = RpcClientErrors.RpcClientError
export type RpcClientError = RpcClientErrors.RpcClientError

export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()(
  "FileSystemError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

export { OpenCodeDriverError } from "../driver/error.js"
export { LlmControllerError, LlmModeError } from "../driver/llm-controller.js"
export {
  UiElementAmbiguousError,
  UiPredicateError,
  UiTimeoutError,
  UiWaitOptionsError,
} from "../driver/ui.js"
export { SimulationCompatibilityError } from "../simulation/connector.js"
export { SimulationRequestError } from "../simulation/rpc.js"
