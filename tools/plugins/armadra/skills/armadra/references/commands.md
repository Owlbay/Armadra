# Commands and inputs

Let `CLIENT` be the absolute installed plugin path to `scripts/armadra.cjs`. Call it with Node and an argument array. Global options are `--profile NAME`, `--data-dir DIRECTORY`, `--json`.

```text
node CLIENT doctor --json
node CLIENT workspaces list --json
node CLIENT connect --workspace WORKSPACE_ID --profile NAME --json
node CLIENT boards list --profile NAME --json
node CLIENT board get --board BOARD_ID --profile NAME --json
node CLIENT graph validate --board BOARD_ID --file graph.json --profile NAME --json
node CLIENT graph apply --board BOARD_ID --file graph.json --key GRAPH_KEY --profile NAME --json
node CLIENT run start --board BOARD_ID --file run.json --key RUN_KEY --profile NAME --json
node CLIENT run get --run RUN_ID --profile NAME --json
node CLIENT run wait --run RUN_ID --cursor CURSOR --timeout 30 --profile NAME --json
node CLIENT run artifacts --run RUN_ID --cursor OFFSET --profile NAME --json
node CLIENT run cancel --run RUN_ID --key CANCEL_KEY --profile NAME --json
node CLIENT disconnect --profile NAME --json
```

`--file -` reads stdin. Mutation keys scope to the profile, workspace and command. Querying a failed run succeeds with exit 0. Without an explicit profile, only a unique profile for the selected data directory can be inferred. Credential contents are never printed.

Profiles normally live in `~/.config/armadra/controller-profiles` (private directory/files). For isolated validation, set `ARMADRA_CONTROLLER_PROFILES_DIR` to a writable temporary directory for **every** client call, including connect. `--data-dir` selects the core instance; it does not relocate profiles. This environment override does not grant filesystem or socket access. A restricted host must separately permit the selected private Unix socket and profile directory.

Graph input uses the revision from `board get`:

```json
{
  "schemaVersion": 1,
  "expectedUpdatedAt": "REVISION_FROM_BOARD",
  "operations": [
    {
      "op": "createNode",
      "key": "implement",
      "type": "terminal",
      "title": "Implement",
      "data": { "kind": "terminal", "agent": { "id": "codex" } }
    },
    {
      "op": "createNode",
      "key": "review",
      "type": "terminal",
      "title": "Review",
      "data": { "kind": "terminal", "agent": { "id": "claude" } }
    },
    {
      "op": "createContextLink",
      "source": { "key": "implement" },
      "target": { "key": "review" },
      "role": "peer"
    }
  ]
}
```

Graph references use `{ "key": "batch-key" }` or `{ "id": "existing-uuid" }`. Creation supports terminal, sticky, group, editor, diff, files and browser; type and `data.kind` must match. Paths are workspace-relative. Browser creation stores an HTTP(S) URL and does not navigate. Groups cannot nest.

`updateNode` takes `node` and `changes` with title, color, position, size or parentId, and only edits this profile's nodes. `removeContextLink` takes an explicit edgeId. No node deletion, session ID, startup command, Shell or token field is accepted. A batch permits 32 new nodes and 128 links, within 256 KiB.

Build run input with UUIDs and the revision returned by `graph apply`:

```json
{
  "schemaVersion": 1,
  "expectedUpdatedAt": "REVISION_FROM_GRAPH_APPLY",
  "tasks": [
    {
      "key": "implement",
      "nodeId": "IMPLEMENT_UUID",
      "prompt": "Implement the approved change; write a change report at reports/change.md.",
      "after": [],
      "outputs": ["reports/change.md"]
    },
    {
      "key": "review",
      "nodeId": "REVIEW_UUID",
      "prompt": "Read reports/change.md and review the actual working directory changes; write reports/review.md.",
      "after": ["implement"],
      "outputs": ["reports/review.md"]
    }
  ],
  "maxConcurrency": 2,
  "deadlineSeconds": 3600
}
```

The workspace must permit execution. Only profile-managed manual Agent nodes participate. v1 automatically associates trusted rounds for Codex and Claude; installed CLI and login availability still matter. A run accepts 1–6 tasks, at most 2000 prompt characters, default concurrency 2 (maximum 4), and at most 24 hours. Configuration is frozen when accepted. No business task retries automatically.

Wait returns events, nextCursor and timedOut. If snapshotRequired, read `run get` and resume from its event cursor. `run get --cursor OFFSET` pages task summaries; `run artifacts --cursor OFFSET` pages references. `run wait --details` opts into a larger page. Summary pages stay within 8 KiB, detailed event pages within 32 KiB. Outputs may be missing. A content hash or metadata version describes the current file, not an archived result.

New events can make wait return immediately, so four event pages do not mean four timeout periods elapsed. To observe until completion within an agreed time, use a wall-clock deadline, pass the returned nextCursor, and inspect run state after each event page. At the deadline, report the actual still-running/blocked state; do not restart or label it failed.
