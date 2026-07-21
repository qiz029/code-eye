# Temporary local web review surface

Add an optional browser surface alongside the TUI overlay so review can use real scrolling, multi-line comment editing, and GitHub-like chrome without replacing the terminal panel.

- Entry points: `/code-eye-web` (user) and `review` with `surface: "web"` (agent). Default `review` surface stays TUI.
- Implementation: ephemeral `127.0.0.1` HTTP server for one review session; open the system browser; shut down when the user submits/closes or the tool/command ends.
- Bind loopback only; no auth beyond "local process"; no cloud hosting.
- Data model is shared with TUI (`ReviewComment`, commit/diff loaders). Web is a view, not a second product.
- Same close semantics as ADR-0002: only user comments leave the session toward the agent.

Rejected for now: embedding in Orca's browser specifically, long-lived daemon, or publishing a public URL.