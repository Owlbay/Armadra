# Failure handling

| Result                                                             | Action                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `core_unavailable`, `instance_mismatch`, `protocol_mismatch`       | Check the selected data directory and existing Armadra startup. Do not start an unknown binary or connect through TCP as a fallback.   |
| `target_required`                                                  | Select an explicit workspace, board, run or profile; do not infer the most recently opened canvas.                                     |
| `revision_conflict`                                                | Re-read the board, preserve intended incremental edits, prepare a fresh request and key.                                               |
| `lease_held`                                                       | The existing editor retains its lease. Report the conflict; do not take it over.                                                       |
| `idempotency_conflict`                                             | The key already names different input. Reconcile the original result before choosing a genuinely new command key.                      |
| `node_busy`                                                        | Inspect the occupying run/session. Do not create a second PTY or change identity to bypass occupation.                                 |
| `authorization_revoked`, `scope_denied`, `scope_changed`           | Report the current authorization or workspace change. A new profile does not justify repeating uncertain work.                         |
| `agent_unavailable`                                                | Report the missing installed CLI/login condition. The plugin does not install or configure vendor CLIs.                                |
| `awaiting_approval`, `awaiting_input`                              | Surface the human action needed in Armadra or the CLI. Do not type an answer or silently change permission mode.                       |
| `launch_unknown`, `launch_write_unknown`, `delivery_unknown`       | Effects may have happened. Query the original run; never resend the prompt. Cancellation is limited to the bound session/generation.   |
| `completion_unknown`, `external_interference`, `connection_lost`   | Do not release dependencies or claim completion. Inspect the run and artifacts; the user may cancel. No force-complete command exists. |
| `session_lost`, `node_deleted`, `agent_error`, `agent_interrupted` | The task did not complete normally; dependent tasks skip. Independent branches may continue.                                           |
| `snapshotRequired`                                                 | Read a current snapshot; history was pruned, not unchanged.                                                                            |
| `artifact_changed`                                                 | The path changed while its reference was checked. Repeat only the artifact query; this does not justify repeating a business task.     |

Exit codes: 0 success/query timeout, 2 invalid input/capability, 3 connection/version/platform, 4 authorization, 5 conflict, 6 internal failure, 7 mutation response unknown. For exit 7, retain the exact request and key and reconcile through the same command. Command idempotency is not exactly-once PTY input.

On core restart, direct sessions can be lost. A surviving tmux pane is attached without resubmission; a disconnected running round can remain blocked when attribution is unavailable. The current artifact file may contain useful work despite a failed or blocked task. Review its contents before reporting quality.
