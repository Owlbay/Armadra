---
name: armadra
description: Operate existing local Armadra canvases and CLI Agent runs from a host that can execute local Node commands. Use for Armadra node batches, context links, execution dependencies, progress, cancellation and artifact references.
---

Use the installed client at the plugin root's `scripts/armadra.cjs`. Derive the plugin root from this SKILL.md: two parents above its containing directory. Use its absolute path with Node.js ≥22, regardless of the current working directory. Do not substitute a repository copy or an unrelated executable on PATH.

Use `--json` and read the `ok/data/error` envelope. Run `doctor` before mutations; require `controller.v1` and `runs.v1`. Select an existing local workspace and board by explicit IDs. When the user's project root uniquely matches a listed workspace, use that match; ask for the target when ambiguous. Connect a workspace-scoped profile and carry it on later calls. An explicit `--data-dir` selects another running core; the client never starts one.

Read [commands](references/commands.md) for command syntax, graph/run input, or a two-Agent example. Read [failure handling](references/failures.md) when a command conflicts, a run blocks, or a result is unknown.

- Read the board's current revision. Validate a graph batch, then apply its incremental operations with a stable key. Use returned UUIDs. Preserve existing nodes, whiteboard and viewport.
- Context links authorize contextual reading; `after` declares execution dependencies. They are separate. Creating a graph starts no shell or Agent. Call `run start` only when the user requested execution.
- Supply prompts and outputs in JSON files or stdin, with command argument arrays. Keep prompts out of Shell interpolation. Retain each mutation's key and exact input until its result is known; identical retries return the original IDs.
- Query summaries. Wait at most 30 seconds per call, using `nextCursor`; a timeout is not failure. An event page may arrive immediately while work is still running. Bound observation by elapsed time, not by a small event-page count; inspect the snapshot and stop at the user's deadline. Avoid repeated idle polling. Continue only when new status is needed for the user's task.
- For `blocked`, surface the reason and required user action. Never answer Agent approval prompts, force completion, or resend an uncertain task. Cancellation uses the returned run ID and a stable key.
- Use `run artifacts` for current workspace-relative references, checking `exists` and pagination. References are not immutable snapshots. Read only the requested artifacts; file presence and `completed` do not prove code quality.

The plugin controls the local core through a private Unix socket. It does not expose MCP, cloud execution, new workspaces, worktree creation, arbitrary Shell execution, publishing or credential management. Windows is unsupported in v1. Preserve each Agent's selected account, model and permission policy.
