---
"opencode-drive": minor
---

Add real terminal mouse move, button, and scroll control through `ui.mouse`, plus an opt-in animated pointer in recordings. Mouse controls and pointer recording negotiate capabilities with OpenCode; older endpoints remain usable for existing operations. Fix keypress placement after recording trims and simplify shared terminal-operation ownership without changing settlement behavior.

Animate pointer travel with a critically damped Motion spring and a configurable, bounded arc while preserving exact recorded input positions and times.
