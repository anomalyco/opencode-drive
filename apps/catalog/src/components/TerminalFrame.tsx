import { useEffect, useRef } from "react"
import type { Frame, FrameArtifact } from "../../catalog/schema"

interface TerminalFrameProps {
  readonly frame: Frame
  readonly label: string
  readonly lazy?: boolean
}

const CellWidth = 10
const CellHeight = 20
const FontSize = 16
const Bold = 1
const Dim = 2
const Italic = 4
const Underline = 8
const Inverse = 32
const Hidden = 64
const Strikethrough = 128
const cache = new Map<string, Promise<FrameArtifact>>()

export function TerminalFrame({ frame, label, lazy = false }: TerminalFrameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    const render = async () => {
      if (lazy && !isNearViewport(canvas)) return
      const artifact = await loadFrame(frame.src)
      await document.fonts.load(`${FontSize}px "Commit Mono"`)
      if (!cancelled) drawFrame(canvas, artifact)
    }
    let observer: IntersectionObserver | undefined
    observer = lazy
      ? new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          observer?.disconnect()
          void render()
        }, { rootMargin: "300px" })
      : undefined
    if (observer) observer.observe(canvas)
    else void render()
    return () => {
      cancelled = true
      observer?.disconnect()
    }
  }, [frame.src, lazy])

  return (
    <canvas
      ref={canvasRef}
      width={frame.cols * CellWidth}
      height={frame.rows * CellHeight}
      role="img"
      aria-label={label}
    />
  )
}

function loadFrame(src: string) {
  const existing = cache.get(src)
  if (existing) return existing
  const pending = fetch(`/${src}`).then(async (response) => {
    if (!response.ok) throw new Error(`Failed to load terminal frame: ${response.status}`)
    return response.json() as Promise<FrameArtifact>
  })
  cache.set(src, pending)
  return pending
}

function drawFrame(canvas: HTMLCanvasElement, frame: FrameArtifact) {
  const context = canvas.getContext("2d")
  if (!context) return
  context.fillStyle = "#080808"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.textBaseline = "top"

  frame.lines.forEach((line, row) => {
    let column = 0
    line.spans.forEach((span) => {
      const attributes = span.attributes & 0xff
      const inverse = Boolean(attributes & Inverse)
      const hidden = Boolean(attributes & Hidden)
      const foreground = inverse ? span.bg : span.fg
      const background = inverse ? span.fg : span.bg
      const chars = [...span.text]
      let remaining = span.width

      chars.forEach((char, index) => {
        const cells = Math.max(1, remaining - (chars.length - index - 1))
        const x = column * CellWidth
        const y = row * CellHeight
        if (background[3]) {
          context.fillStyle = color(background)
          context.fillRect(x, y, cells * CellWidth, CellHeight)
        }
        if (!hidden && char.codePointAt(0) !== 0x0a00) {
          context.fillStyle = color(foreground, attributes & Dim ? 0.55 : 1)
          if (!drawBlockElement(context, char, x, y, cells)) {
            context.font = `${attributes & Italic ? "italic " : ""}${attributes & Bold ? "bold " : ""}${FontSize}px "Commit Mono"`
            context.fillText(char, x, y + 1)
          }
          if (attributes & Underline) context.fillRect(x, y + 17, cells * CellWidth, 1)
          if (attributes & Strikethrough) context.fillRect(x, y + 10, cells * CellWidth, 1)
        }
        column += cells
        remaining -= cells
      })
      while (remaining-- > 0) {
        if (background[3]) {
          context.fillStyle = color(background)
          context.fillRect(column * CellWidth, row * CellHeight, CellWidth, CellHeight)
        }
        column++
      }
    })
  })
}

function drawBlockElement(context: CanvasRenderingContext2D, char: string, x: number, y: number, cells: number) {
  const width = cells * CellWidth
  if (char === "█") context.fillRect(x, y, width, CellHeight)
  else if (char === "▀") context.fillRect(x, y, width, CellHeight / 2)
  else if (char === "▄") context.fillRect(x, y + CellHeight / 2, width, CellHeight / 2)
  else if (char === "┃") context.fillRect(x + CellWidth / 2 - 1, y, 2, CellHeight)
  else if (char === "╹") context.fillRect(x + CellWidth / 2 - 1, y, 2, CellHeight / 2)
  else return false
  return true
}

function color([red, green, blue, alpha]: FrameArtifact["lines"][number]["spans"][number]["fg"], opacity = 1) {
  return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255) * opacity})`
}

function isNearViewport(element: HTMLElement) {
  const bounds = element.getBoundingClientRect()
  return bounds.bottom >= -300 && bounds.top <= window.innerHeight + 300
}
