import { fileURLToPath } from "node:url"
import { GlobalFonts, createCanvas, type SKRSContext2D } from "@napi-rs/canvas"
import { TextStyle, type CapturedFrame } from "./types.js"

const CellWidth = 10
const CellHeight = 20
const FontSize = 16
const FontFamily = "OpenCode Mono"
const SymbolFontFamily = "OpenCode Symbols"

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
for (const file of [
  "noto-sans-symbols-2-symbols-400-normal.woff2",
  "noto-sans-symbols-2-braille-400-normal.woff2",
]) {
  const path = fileURLToPath(import.meta.resolve(`@fontsource/noto-sans-symbols-2/files/${file}`))
  if (!GlobalFonts.registerFromPath(path, SymbolFontFamily))
    throw new Error(`Failed to register capture symbol font: ${path}`)
}

function color(rgb: number, alpha = 1) {
  return `rgba(${(rgb >> 16) & 255}, ${(rgb >> 8) & 255}, ${rgb & 255}, ${alpha})`
}

const baselineCache = new Map<string, number>()

type Measurable = {
  measureText(text: string): {
    readonly fontBoundingBoxAscent?: number
    readonly fontBoundingBoxDescent?: number
  }
}

function baselineOffset(context: Measurable, font: string) {
  const cached = baselineCache.get(font)
  if (cached !== undefined) return cached
  const metrics = context.measureText("Mg")
  const ascent = metrics.fontBoundingBoxAscent ?? FontSize * 0.8
  const descent = metrics.fontBoundingBoxDescent ?? FontSize * 0.2
  // Center the font's bounding box in the cell and return its alphabetic baseline.
  const offset = (CellHeight - (ascent + descent)) / 2 + ascent
  baselineCache.set(font, offset)
  return offset
}

function drawBlockElement(context: SKRSContext2D, char: string, x: number, y: number) {
  if (char === "█") context.fillRect(x, y, CellWidth, CellHeight)
  else if (char === "▀") context.fillRect(x, y, CellWidth, CellHeight / 2)
  else if (char === "▄") context.fillRect(x, y + CellHeight / 2, CellWidth, CellHeight / 2)
  else return false
  return true
}

export interface RenderFrameOptions {
  readonly cols?: number
  readonly rows?: number
}

export function renderFrame(frame: CapturedFrame, options: RenderFrameOptions = {}): Buffer {
  const cols = Math.max(frame.cols, options.cols ?? frame.cols)
  const rows = Math.max(frame.rows, options.rows ?? frame.rows)
  const canvas = createCanvas(cols * CellWidth, rows * CellHeight)
  const context = canvas.getContext("2d")
  context.fillStyle = "#080808"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.textBaseline = "alphabetic"
  context.textAlign = "center"

  frame.lines.forEach((line, row) => {
    let column = 0
    for (const span of line.spans) {
      const inverse = Boolean(span.attributes & TextStyle.inverse)
      const hidden = Boolean(span.attributes & TextStyle.invisible)
      const foreground = inverse ? span.bg : span.fg
      const background = inverse ? span.fg : span.bg
      let remaining = span.width
      for (const char of span.text) {
        const cells = Math.min(Math.max(1, Bun.stringWidth(char)), remaining)
        context.fillStyle = color(background)
        context.fillRect(column * CellWidth, row * CellHeight, cells * CellWidth, CellHeight)
        if (!hidden) {
          const italic = span.attributes & TextStyle.italic ? "italic " : ""
          const weight = span.attributes & TextStyle.bold ? "700 " : "400 "
          const font = `${italic}${weight}${FontSize}px "${FontFamily}", "${SymbolFontFamily}"`
          context.font = font
          context.fillStyle = color(foreground, span.attributes & TextStyle.dim ? 0.55 : 1)
          const x = column * CellWidth
          const y = row * CellHeight
          if (!drawBlockElement(context, char, x, y))
            context.fillText(
              char,
              x + (cells * CellWidth) / 2,
              y + baselineOffset(context, font),
              cells * CellWidth,
            )
          if (span.attributes & TextStyle.underline) {
            context.fillRect(column * CellWidth, row * CellHeight + 17, cells * CellWidth, 1)
          }
          if (span.attributes & TextStyle.strikethrough) {
            context.fillRect(column * CellWidth, row * CellHeight + 10, cells * CellWidth, 1)
          }
        }
        column += cells
        remaining -= cells
      }
      if (remaining > 0) {
        context.fillStyle = color(background)
        context.fillRect(column * CellWidth, row * CellHeight, remaining * CellWidth, CellHeight)
        column += remaining
      }
    }
  })

  if (frame.cursor.visible && frame.cursor.row >= 0 && frame.cursor.row < frame.rows) {
    context.strokeStyle = "#d8d8d8"
    context.lineWidth = 2
    context.strokeRect(
      frame.cursor.col * CellWidth + 1,
      frame.cursor.row * CellHeight + 1,
      CellWidth - 2,
      CellHeight - 2,
    )
  }
  return canvas.toBuffer("image/png")
}
