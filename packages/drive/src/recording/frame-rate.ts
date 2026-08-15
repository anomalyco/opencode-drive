const DefaultFps = 60

export function resolveFps(fps = DefaultFps) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("fps must be a positive finite number")
  return fps
}

export function progressReporter(onProgress?: (percent: number) => void) {
  let reported = 0
  return (percent: number) => {
    const target = Math.min(100, Math.floor(percent / 10) * 10)
    while (reported < target) {
      reported += 10
      onProgress?.(reported)
    }
  }
}
