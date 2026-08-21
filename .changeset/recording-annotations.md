---
"opencode-drive": minor
---

Annotated recording exports. `tui.recording.mark(label)` labels the current instant during a recorded run; marks become a burned-in footer in the exported video (segment label bottom-left, elapsed timecode and "drive" branding bottom-right). `exportRecording` gains `footer`, `annotations`, and `clips` options — clips trim, re-speed (`speed`), and freeze (`holdMs`) segments of the raw timeline, concatenated in order. `SampledFrame` now carries `sourceAtMs` (raw timeline time before trim/rebase) alongside the exported `atMs`.
