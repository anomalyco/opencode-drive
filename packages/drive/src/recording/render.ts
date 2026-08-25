import { fileURLToPath } from "node:url"
import { GlobalFonts, createCanvas, loadImage } from "@napi-rs/canvas"
import {
  CellHeight,
  CellWidth,
  DimAlpha,
  FontSize,
  StrikethroughOffset,
  TextStyle,
  UnderlineOffset,
  baselineOffset,
  drawBlockGlyph,
} from "../frame/index.js"
import type { Frontend } from "../client/protocol.js"
import type { CapturedFrame } from "./types.js"

export { CellHeight, CellWidth } from "../frame/index.js"

const FontFamily = "OpenCode Mono"
const SymbolFontFamily = "OpenCode Symbols"
const SymbolFontFamily2 = "OpenCode Symbols 2"
const MathFontFamily = "OpenCode Math"
const FontStack = `"${FontFamily}", "${SymbolFontFamily}", "${SymbolFontFamily2}", "${MathFontFamily}"`

const fontOverride = process.env["OPENCODE_DRIVE_FONT"]
const fontFiles = fontOverride
  ? fontOverride
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean)
  : [
      "CommitMono-400-Regular.otf",
      "CommitMono-700-Regular.otf",
      "CommitMono-400-Italic.otf",
      "CommitMono-700-Italic.otf",
    ].map((file) => fileURLToPath(new URL(`../../assets/fonts/commit-mono/${file}`, import.meta.url)))

if (fontFiles.length === 0)
  throw new Error("OPENCODE_DRIVE_FONT must contain at least one font file")
for (const file of fontFiles) {
  if (!GlobalFonts.registerFromPath(file, FontFamily))
    throw new Error(`Failed to register capture font: ${file}`)
}
for (const [file, family] of [
  ["NotoSansSymbols.ttf", SymbolFontFamily],
  ["NotoSansSymbols2-Regular.ttf", SymbolFontFamily2],
  ["NotoSansMath-Regular.ttf", MathFontFamily],
] as const) {
  const path = fileURLToPath(new URL(`../../assets/fonts/noto/${file}`, import.meta.url))
  if (!GlobalFonts.registerFromPath(path, family))
    throw new Error(`Failed to register capture symbol font: ${path}`)
}

function color(value: number | Frontend.Color, opacity = 1) {
  if (typeof value === "number")
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`
  return `rgba(${value[0]}, ${value[1]}, ${value[2]}, ${(value[3] / 255) * opacity})`
}

export interface RenderFrameFooter {
  /** Segment label drawn in the bottom-left. */
  readonly label?: string
  /** Elapsed output time drawn left of the brand as M:SS. */
  readonly timecodeMs?: number
  /** Brand drawn bold in the bottom-right. Defaults to "drive". */
  readonly brand?: string
}

export interface RenderFrameOptions {
  readonly cols?: number
  readonly rows?: number
  readonly header?: string
  readonly footer?: RenderFrameFooter
  /** Recent semantic key presses, rendered as a KeyCastr-style overlay. */
  readonly keys?: ReadonlyArray<string>
}

export const FooterHeight = 40

export function formatTimecode(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

export function renderFrame(frame: CapturedFrame | Frontend.CapturedFrame, options: RenderFrameOptions = {}): Buffer {
  const cols = Math.max(frame.cols, options.cols ?? frame.cols)
  const rows = Math.max(frame.rows, options.rows ?? frame.rows)
  const headerHeight = options.header ? 40 : 0
  const footerHeight = options.footer ? FooterHeight : 0
  const canvas = createCanvas(cols * CellWidth, rows * CellHeight + headerHeight + footerHeight)
  const context = canvas.getContext("2d")
  context.fillStyle = "#080808"
  context.fillRect(0, 0, canvas.width, canvas.height)
  if (options.header) {
    context.fillStyle = "#151515"
    context.fillRect(0, 0, canvas.width, headerHeight)
    context.font = `700 ${FontSize}px ${FontStack}`
    context.fillStyle = "#d8d8d8"
    context.textBaseline = "middle"
    context.textAlign = "left"
    context.fillText(options.header, 16, headerHeight / 2, canvas.width - 32)
  }
  if (options.footer) {
    const footerTop = canvas.height - footerHeight
    const middle = footerTop + footerHeight / 2
    context.fillStyle = "#151515"
    context.fillRect(0, footerTop, canvas.width, footerHeight)
    context.textBaseline = "middle"
    const brand = options.footer.brand ?? "drive"
    context.font = `700 ${FontSize}px ${FontStack}`
    const brandWidth = context.measureText(brand).width
    context.fillStyle = "#d8d8d8"
    context.textAlign = "right"
    context.fillText(brand, canvas.width - 16, middle)
    let reserved = brandWidth + 32
    if (options.footer.timecodeMs !== undefined) {
      const timecode = formatTimecode(options.footer.timecodeMs)
      context.font = `400 ${FontSize}px ${FontStack}`
      context.fillStyle = "#8a8a8a"
      context.fillText(timecode, canvas.width - 16 - brandWidth - 12, middle)
      reserved += context.measureText(timecode).width + 12
    }
    if (options.footer.label) {
      context.font = `400 ${FontSize}px ${FontStack}`
      context.fillStyle = "#8a8a8a"
      context.textAlign = "left"
      context.fillText(options.footer.label, 16, middle, Math.max(0, canvas.width - 16 - reserved - 16))
    }
  }
  context.textBaseline = "alphabetic"
  context.textAlign = "center"

  frame.lines.forEach((line, row) => {
    let column = 0
    for (const span of line.spans) {
      const inverse = Boolean(span.attributes & TextStyle.inverse)
      const hidden = Boolean(span.attributes & TextStyle.invisible)
      const foreground = inverse ? span.bg : span.fg
      const background = inverse ? span.fg : span.bg
      const y = headerHeight + row * CellHeight
      context.fillStyle = color(background)
      context.fillRect(column * CellWidth, y, span.width * CellWidth, CellHeight)
      if (hidden) {
        column += span.width
        continue
      }
      const italic = span.attributes & TextStyle.italic ? "italic " : ""
      const weight = span.attributes & TextStyle.bold ? "700 " : "400 "
      const font = `${italic}${weight}${FontSize}px ${FontStack}`
      context.font = font
      context.fillStyle = color(foreground, span.attributes & TextStyle.dim ? DimAlpha : 1)
      const baseline = baselineOffset(context, font)
      let remaining = span.width
      for (const char of span.text) {
        const cells = Math.min(Math.max(1, Bun.stringWidth(char)), remaining)
        const x = column * CellWidth
        if (!drawBlockGlyph(context, char, x, y, cells))
          context.fillText(
            char,
            x + (cells * CellWidth) / 2,
            y + baseline,
            cells * CellWidth,
          )
        if (span.attributes & TextStyle.underline) {
          context.fillRect(x, y + UnderlineOffset, cells * CellWidth, 1)
        }
        if (span.attributes & TextStyle.strikethrough) {
          context.fillRect(x, y + StrikethroughOffset, cells * CellWidth, 1)
        }
        column += cells
        remaining -= cells
      }
      if (remaining > 0) {
        column += remaining
      }
    }
  })

  const cursor = frame.cursor
  if ("visible" in cursor && cursor.visible && cursor.row >= 0 && cursor.row < frame.rows) {
    context.strokeStyle = "#d8d8d8"
    context.lineWidth = 2
    context.strokeRect(
      cursor.col * CellWidth + 1,
      headerHeight + cursor.row * CellHeight + 1,
      CellWidth - 2,
      CellHeight - 2,
    )
  }
  if (options.keys && options.keys.length > 0) {
    context.font = `700 ${FontSize}px ${FontStack}`
    context.textBaseline = "middle"
    context.textAlign = "center"
    const gap = 8
    const padding = 14
    const height = 34
    const available = Math.max(1, canvas.width - 16)
    const pills: Array<{ readonly key: string; readonly width: number }> = []
    for (const key of options.keys.toReversed()) {
      const width = Math.min(
        available,
        Math.ceil(context.measureText(key).width) + padding * 2,
      )
      const used = pills.reduce((sum, pill) => sum + pill.width, 0) + gap * pills.length
      if (pills.length > 0 && used + width > available) continue
      pills.unshift({ key, width })
    }
    const total = pills.reduce((sum, pill) => sum + pill.width, 0) + gap * (pills.length - 1)
    let x = Math.max(8, (canvas.width - total) / 2)
    const terminalBottom = headerHeight + rows * CellHeight
    const y = Math.max(headerHeight + 2, terminalBottom - height - 16)
    for (const pill of pills) {
      context.fillStyle = "rgba(8, 8, 8, 0.88)"
      context.beginPath()
      context.roundRect(x, y, pill.width, height, 8)
      context.fill()
      context.strokeStyle = "rgba(255, 255, 255, 0.20)"
      context.lineWidth = 1
      context.stroke()
      context.fillStyle = "#f0f0f0"
      context.fillText(
        pill.key,
        x + pill.width / 2,
        y + height / 2,
        Math.max(1, pill.width - padding * 2),
      )
      x += pill.width + gap
    }
  }
  return canvas.toBuffer("image/png")
}

export async function joinFrames(left: Buffer, right: Buffer): Promise<Buffer> {
  const [leftImage, rightImage] = await Promise.all([loadImage(left), loadImage(right)])
  if (leftImage.height !== rightImage.height)
    throw new Error(
      `comparison recordings must have the same height: ${leftImage.height} !== ${rightImage.height}`,
    )
  const canvas = createCanvas(leftImage.width + rightImage.width, leftImage.height)
  const context = canvas.getContext("2d")
  context.drawImage(leftImage, 0, 0)
  context.drawImage(rightImage, leftImage.width, 0)
  return canvas.toBuffer("image/png")
}
