---
name: code-eye
description: Open an interactive code review of the current changes in the user's browser, optionally with an agent-guided walkthrough of the key changes. Use when the user asks to review changes, walk through what changed, or leave diff comments.
---

Open the current changes (uncommitted + base..HEAD commits) for review in the user's browser via the code-eye MCP `review` tool.

Two modes:

1. **Walkthrough (default)** — inspect the uncommitted changes (`git diff HEAD`) and the commits in the base..HEAD range (`git log`, `git show`), then call `review` with a summary and an ordered list of walkthrough stops: the key changes, design decisions, and risky spots the user should pay attention to. For each stop provide:
   - sha: short commit sha from git log (omit or empty for uncommitted changes)
   - file: path exactly as it appears in the diff header (repo-relative, e.g. src/foo.ts — not absolute)
   - line: line number on the NEW side of the file (the number after + in the @@ hunk header, counting added/context lines)
   - title: short headline
   - detail: the context the user needs to evaluate it
   - kind: optional tag like change / risk / note

   Only point stops at lines that actually appear in the diff (added or context lines). Prefer the first changed line of each conceptual edit.

2. **Plain review** — when the user just wants to look at the diff without guidance, call `review` with no arguments.

The tool blocks until the user closes the panel. Any line comments the user left come back as the tool result — address each one. A close without comments means the review is accepted; do not treat it as a request for more work.
