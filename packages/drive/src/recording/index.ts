export { decodeTimeline } from "./decode.js"
export {
  applyClips,
  labelAt,
  type EditedSample,
  type RecordingAnnotation,
  type RecordingClip,
} from "./edit.js"
export { encodeFrames, type EncodeOptions, type ImageFrame } from "./encode.js"
export { exportRecording, type ExportRecordingOptions, type ExportRecordingResult } from "./export.js"
export { appendMark, loadAnnotations, marksPath } from "./marks.js"
export { formatTimecode, joinFrames, renderFrame, type RenderFrameFooter } from "./render.js"
export { replayRecording, type ReplayOptions } from "./replay.js"
export type {
  CapturedFrame,
  CapturedLine,
  CapturedSpan,
  SampledFrame,
  TimelineHeader,
  TimelineOutput,
  TimelineRecord,
} from "./types.js"
