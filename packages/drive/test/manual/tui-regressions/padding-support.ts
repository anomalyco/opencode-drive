import type { Frontend } from "../../../src/simulation/protocol.js"

type CapturedFrame = Frontend.CapturedFrame
type Line = CapturedFrame["lines"][number]

export const frameText = (line: Line) => line.spans.map((span) => span.text).join("")

// A transcript block row has its left border glyph in the first five columns.
const borderColumn = (line: Line) => {
  const index = frameText(line).slice(0, 5).search(/[┃│]/)
  return index === -1 ? undefined : index
}

// The composer is the last bordered block and legitimately ends on its
// agent/model row, so only transcript blocks above it are checked.
export function transcriptPaddingFindings(frame: CapturedFrame) {
  const bordered = frame.lines.map((line) => borderColumn(line) !== undefined)
  let end = bordered.length - 1
  while (end >= 0 && !bordered[end]) end -= 1
  while (end >= 0 && bordered[end]) end -= 1
  const rows = frame.lines.slice(0, end + 1)
  const issues: string[] = []
  let start: number | undefined
  // Toasts render right-aligned over the transcript; only the block's own left region counts.
  const inner = (line: Line) =>
    frameText(line)
      .slice((borderColumn(line) ?? 0) + 1, Math.max(20, frame.cols - 50))
      .trim()
  const flush = (last: number) => {
    if (start === undefined) return
    if (start > 1 && inner(rows[start]!) !== "")
      issues.push(`block ${start}-${last}: first bordered row has text: ${JSON.stringify(inner(rows[start]!))}`)
    if (inner(rows[last]!) !== "")
      issues.push(`block ${start}-${last}: last bordered row has text: ${JSON.stringify(inner(rows[last]!))}`)
    start = undefined
  }
  rows.forEach((line, index) => {
    if (borderColumn(line) !== undefined) {
      if (start === undefined) start = index
      return
    }
    flush(index - 1)
  })
  flush(rows.length - 1)
  return issues
}
