# Work Ledger

The Work Ledger is CSM's observed execution-provenance layer. It complements knowledge continuity and work-state continuity by recording which captured run and model changed each file, what content delta was introduced, and whether that recorded content still survives.

## Stored contract

Each `work_ledger_changes` row contains:

- `change_id`, `run_id`, `session_id`, `model_id`, `tool_call_id`, and `tool_name`
- `project_root` and normalized project-relative `file_path`
- SHA-256 `before_hash`, `after_hash`, and `patch_hash`
- nullable `commit_sha`
- `created_at`, `status`, and `last_verified_at`
- `superseded_by[]`, `supersedes[]`, and `surviving_patch_hash`
- `lineage_manifest` JSONB containing changed-line hashes and before/after occurrence counts

The ledger does not store source text or patches. Its changed-line count manifest deterministically measures recorded content presence while avoiding a second database copy of repository content. It does not prove hunk position, Git blame, or causal ownership after code is moved, reordered, or independently recreated.

Text files receive changed-line survival manifests. Files containing NUL bytes use exact before/after hashes only; partial binary-hunk survival is not claimed.

## Status semantics

- `active`: all recorded changed-line units are present in the current file state.
- `partially_superseded`: only part of the recorded changed-line contribution is present.
- `superseded`: none of the patch contribution survives and the file is not the exact preimage.
- `reverted`: the file matches the exact `before_hash`.

When a tracked later change degrades earlier lineage, the earlier row appends the later `change_id` to `superseded_by`; the later row records the earlier IDs in `supersedes`. Untracked external changes still update survival status during verification, but no superseding run is invented.

Terminal `superseded` and `reverted` rows never become active again merely because identical content is later reintroduced. A partial row never improves back to active. Because only a subset hash is stored, a later different partial subset is conservatively terminalized as `superseded` rather than transferring ownership to independently recreated content. This monotonic rule favors false negatives over false attribution.

## Capture surfaces

OpenCode `edit`, `write`, `multiedit`, `patch`, and `apply_patch` calls with recognized path arguments are captured automatically through tool before/after hooks. Recognized shapes include `filePath`, `path`, `files`, `edits`, OpenAI patch headers including `Move to`, and unified-diff file headers with optional timestamps or Git-style quoting/escapes. A plugin-process UUID becomes `run_id` unless `CSM_RUN_ID` is supplied. Host `chat.message` metadata supplies `provider:model`; `CSM_MODEL_ID` pins an orchestrator-provided identity.

Host model identity is tracked per session so interleaved sessions cannot inherit each other's model. If a tool call arrives before the host has supplied model metadata, `model_id` is the explicit sentinel `unknown`; query metadata counts that row as a `provenanceGaps` entry instead of implying exact attribution. Idempotency is scoped by run, tool call, project root, and relative path, so identical call IDs in separate repositories remain distinct.

Codex bridge hosts must call `beginWorkChange()` before the filesystem mutation and `completeWorkChange()` afterward with the same run, session, model, tool call, project root, and file arguments. This is explicit because the bridge cannot observe Codex filesystem tools by itself.

SQLite core-memory mode does not create or advertise the Work Ledger. PostgreSQL full runtime is required.

Capture windows take PostgreSQL advisory session locks in canonical file order, so overlapping supported edits are serialized across plugin processes before either tool mutates the file. Supported before-capture failures fail closed. An after-capture failure is surfaced to the host, but the filesystem mutation has already happened and requires operator reconciliation.

On Windows, canonical project-relative file identities are case-folded before lock, idempotency, and lineage operations. This makes differently cased aliases—including concurrent creates—share one ledger identity on the normal case-insensitive Windows filesystem. Case-sensitive Windows directories are outside this version's supported Work Ledger boundary because Node does not expose a reliable non-mutating per-directory sensitivity probe.

This adapter is not run-complete: shell commands, tools without recognized paths, external processes, missing after-hooks, and process crashes are not durably represented. Query metadata therefore reports `captureScope=supported_file_tools_only` and `runComplete=false`. It must not be presented as proof that every mutation by a run was captured.

## Query

The read-only `csm_work_ledger_surviving` tool defaults to the current run and project. It rereads current files, refreshes every row's status and surviving hash, and returns only observed `active` and `partially_superseded` changes.

Direct bridge callers use:

```ts
const changes = await bridge.getSurvivingWorkChanges({
  runId: 'orchestrator-run-123',
  projectRoot: process.cwd(),
});
```

`commit_sha` is intentionally nullable and is never inferred from `HEAD`, because an uncommitted change's current `HEAD` is its base commit, not the commit that eventually contains it. After commit creation, bridge hosts can call `correlateWorkChangesToCommit({ changeIds, commitSha })`; only full 40-character SHA-1 or 64-character SHA-256 IDs are accepted.

## Trust boundary

The Work Ledger assumes a trusted, single-tenant PostgreSQL database and trusted tool callers. Line hashes are unsalted SHA-256 and may reveal predictable source lines through dictionary attacks. The query accepts run/project filters and returns provenance metadata; it is not a tenant authorization boundary. Path containment uses canonical roots and symlink checks, but a hostile local process can still race a filesystem check and read.
