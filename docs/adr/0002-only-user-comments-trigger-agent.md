# Only user comments re-trigger the agent

Closing the review panel must not ping the agent unless the user left at least one `author: "user"` comment.

- `/code-eye` and `/code-eye-web`: send a follow-up message only when user comments exist; clean close is silent.
- `review` tool result: if there are no user comments, return a short "no comments / no further action" result that does not ask the agent to keep editing; if there are user comments, return only those (never echo agent walkthrough text back as work items).

Rationale: walkthrough is inbound guidance from the agent; feeding it back would create a no-op loop. Silent "LGTM" closes are the common path.
