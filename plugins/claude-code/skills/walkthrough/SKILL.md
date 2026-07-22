---
description: Give the user a guided walkthrough of the current changes in a browser review panel. Use when the user asks to walk through, tour, or explain what changed before review.
---

Give the user a guided walkthrough of the current changes. Inspect the uncommitted changes (`git diff HEAD`) and the commits in the base..HEAD range (`git log`, `git show`), then call the code-eye MCP `review` tool (`mcp__plugin_code-eye_code-eye__review` when installed as a plugin) with a summary and an ordered list of walkthrough stops: the key changes, design decisions, and risky spots the user should pay attention to.

For each stop provide:
- sha: short commit sha from git log (omit or empty for uncommitted changes)
- file: path exactly as it appears in the diff header (repo-relative, e.g. src/foo.ts — not absolute)
- line: line number on the NEW side of the file (the number after + in the @@ hunk header, counting added/context lines)
- title: short headline
- detail: the context the user needs to evaluate it
- kind: optional tag like change / risk / note

Only point stops at lines that actually appear in the diff (added or context lines). Prefer the first changed line of each conceptual edit.

The tool opens the review in the user's browser with your stops attached as read-only notes, and blocks until the user closes it. Any line comments the user left come back as the tool result — address each one. A close without comments means the review is accepted.
