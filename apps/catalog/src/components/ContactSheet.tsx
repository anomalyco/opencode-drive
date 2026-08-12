import { useEffect, useEffectEvent, useRef } from "react"
import type { Screen } from "../catalog"
import { frameFor, screenFamily } from "../catalog"
import { CaptureContextMenu } from "./CaptureContextMenu"
import { IdChip } from "./IdChip"
import { TerminalFrame } from "./TerminalFrame"

interface ContactSheetProps {
  readonly screens: ReadonlyArray<Screen>
  readonly selectedId: string | undefined
  readonly focusTick: number
  readonly keyboardEnabled: boolean
  readonly variantId: string
  readonly onSelect: (id: string) => void
  readonly onOpen: (id: string) => void
  readonly deepLinkFor: (id: string) => string
}

export function ContactSheet({
  screens,
  selectedId,
  focusTick,
  keyboardEnabled,
  variantId,
  onSelect,
  onOpen,
  deepLinkFor,
}: ContactSheetProps) {
  const gridRef = useRef<HTMLElement>(null)
  const focusedTick = useRef(0)

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (screens.length === 0) return
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    const editing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    if (editing) return
    const current = Math.max(
      0,
      screens.findIndex((screen) => screen.id === selectedId),
    )
    let next: number | undefined
    if (event.key === "Home") next = 0
    if (event.key === "End") next = screens.length - 1
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const step = event.key === "ArrowLeft" ? -1 : 1
      next = Math.min(screens.length - 1, Math.max(0, current + step))
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const cards = Array.from(gridRef.current?.querySelectorAll<HTMLElement>("[data-screen]") ?? [])
      const active = cards.find((card) => card.dataset.screen === selectedId)
      if (active) {
        const origin = active.getBoundingClientRect()
        const direction = event.key === "ArrowUp" ? -1 : 1
        const candidates = cards
          .map((card, index) => ({ card, index, rect: card.getBoundingClientRect() }))
          .filter(({ rect }) => direction * (rect.top - origin.top) > 4)
          .sort((a, b) => {
            const aScore = Math.abs(a.rect.left - origin.left) + Math.abs(a.rect.top - origin.top) * 0.25
            const bScore = Math.abs(b.rect.left - origin.left) + Math.abs(b.rect.top - origin.top) * 0.25
            return aScore - bScore
          })
        next = candidates[0]?.index
      }
    }
    if (next === undefined) return
    event.preventDefault()
    const screen = screens[next]
    if (screen) onSelect(screen.id)
  })

  useEffect(() => {
    if (!keyboardEnabled) return
    const listener = (event: KeyboardEvent) => handleKeyDown(event)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [keyboardEnabled])

  useEffect(() => {
    if (focusTick === focusedTick.current) return
    focusedTick.current = focusTick
    if (selectedId === undefined) return
    const card = gridRef.current?.querySelector<HTMLElement>(`[data-screen="${CSS.escape(selectedId)}"]`)
    card?.focus()
  }, [focusTick, selectedId])

  return (
    <section className="contact-sheet" aria-label="Terminal captures" ref={gridRef}>
      {screens.length === 0 ? (
        <p className="empty-state">No captures match.</p>
      ) : (
        Array.from(Map.groupBy(screens, screenFamily), ([category, categoryScreens]) => (
          <section className="capture-family" id={`family-${category}`} key={category}>
            <header className="capture-family-heading">
              <h2>{category}</h2>
              <span>{categoryScreens.length}</span>
            </header>
            <div className="capture-family-grid">
              {categoryScreens.map((screen) => {
                const frame = frameFor(screen, variantId)
                if (!frame) return undefined
                return (
                  <article
                    key={screen.id}
                    className={`capture-card${screen.id === selectedId ? " selected" : ""}`}
                  >
                    <button
                      type="button"
                      data-screen={screen.id}
                      className="capture-open"
                      tabIndex={screen.id === selectedId ? 0 : -1}
                      aria-label={`Open ${screen.title}`}
                      onClick={() => onOpen(screen.id)}
                      onFocus={() => {
                        if (screen.id !== selectedId) onSelect(screen.id)
                      }}
                    >
                      <CaptureContextMenu identifier={screen.id} deepLink={deepLinkFor(screen.id)}>
                        <span className="capture-frame">
                          <TerminalFrame frame={frame} label={screen.title} />
                        </span>
                      </CaptureContextMenu>
                    </button>
                    <footer className="capture-caption">
                      <span className="capture-title-wrap">
                        <span className="capture-title">{screen.title}</span>
                        <span className="capture-state">{screen.states.join(" · ")}</span>
                      </span>
                      <IdChip id={screen.id} className="id-chip-end" />
                    </footer>
                  </article>
                )
              })}
            </div>
          </section>
        ))
      )}
    </section>
  )
}
