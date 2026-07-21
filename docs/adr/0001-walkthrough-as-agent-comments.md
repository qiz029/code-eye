# Walkthrough stops are agent comments

Walkthroughs and user notes both anchor to `(sha, file, side, line)`, so we model agent walkthrough output as `ReviewComment` with `author: "agent"` instead of a parallel stop/banner system.

User and agent comments can share a line (key includes `author`). Agent comments are read-only guidance; only user comments are editable/deletable. Session persistence keeps user comments only — agent walkthrough is regenerated each time the agent opens review.

Overview-only text with no file/line may still appear as summary chrome, but per-stop navigation is comment/jump based, not a separate stop list.
