---
description: Open an interactive code review of the current changes in the user's browser. Use when the user asks to review changes, open the review panel, or leave diff comments.
---

Call the code-eye MCP `review` tool (`mcp__plugin_code-eye_code-eye__review` when installed as a plugin) with no arguments. It opens the current changes (uncommitted + base..HEAD commits) in the user's browser and blocks until the user closes the panel.

Any line comments the user left come back as the tool result — address each one. A close without comments means the review is accepted; do not treat it as a request for more work.

If the user seems to want guidance on what to look at, use the walkthrough skill instead of calling the tool bare.
