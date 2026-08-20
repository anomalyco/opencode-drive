---
"opencode-drive": patch
---

Fix two controlled-tool transport defects: `/execute` requests are exempt from Bun's idle timeout (a silent controlled tool no longer has its transport killed at the 255s ceiling), and plugin tool results no longer carry an `output` value, which opencode's tool runtime rejects for tools that declare no output schema.
