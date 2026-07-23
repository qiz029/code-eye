# Cross-host support via MCP stdio server

Support Claude Code and Codex in addition to pi, without forking the codebase per host.

- Architecture: one npm package, three thin host shells over shared core modules (`git.ts`, `comments.ts`, `walkthrough.ts`, `parse-unidiff.ts`, `web-review.ts`). `mcp-server.ts` is a stdio MCP server exposing the same `review` tool; the pi extension (`index.ts`) is untouched.
- Review surface on Claude Code / Codex is the web surface only (ADR-0003): neither host's TUI exposes a custom component API, and MCP server processes run outside both hosts' sandboxes, so the ephemeral 127.0.0.1 server + browser open works unmodified. The TUI overlay (`review-view.ts`) stays pi-only.
- Blocking semantics: the `review` tool call blocks until the user closes the review; user comments return as the tool result (ADR-0002 unchanged). Host mitigations:
  - Claude Code kills MCP calls idle for 30 min → the server sends `notifications/progress` heartbeats every 60s when the client passes a `progressToken`.
  - Codex's default `tool_timeout_sec` is 60s → users must raise it (documented in README; not settable from a plugin manifest).
  - Headless sessions (`CI` env) fail fast with a "summarize in chat" message instead of hanging.
- Under MCP stdio, stdout is the protocol channel — `web-review.ts` logs its URL on stderr.
- Distribution: the repo itself is a plugin marketplace for both hosts (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`); plugins live in `plugins/` and launch the server via `npx` from the published npm package. The MCP entry is esbuild-bundled to a single `dist/code-eye-mcp.mjs` bin.
- Comment persistence: superseded by ADR-0005 — user comments and the last-reviewed HEAD now persist to `<gitdir>/code-eye/state.json` (the process-memory store described here originally was the pre-ADR-0005 behavior).

Rejected: tmux/kitty overlay hacks or forking the Codex TUI for a terminal surface (coverage/maintenance cost); MCP elicitation as the interaction channel (short-form Q&A, unfit for diff review).
