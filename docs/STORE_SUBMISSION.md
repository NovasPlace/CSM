# Store Submission Checklist

This checklist covers a future hosted public-directory submission. It is separate from the
self-hosted npm package, direct `csm-mcp` setup, and PostgreSQL-only Codex marketplace plugin already
described in `CODEX_INSTALLATION.md`.

## Positioning
- Problem: agents lose continuity, burn quota, and repeat work across long sessions.
- Promise: keep task continuity while reducing active context pressure and prompt spend.
- Proof: Phase 32 benchmarks and workspace replay evidence document the savings.

## Public Listing Copy
- Name: `Cross-Session Memory Bridge`
- Short description: `Resume Codex work across sessions.`
- Long description: `Self-hosted memory, context briefs, lessons, checkpoints, and handoff tools for durable Codex project continuity.`
- Category: `Productivity`
- Capabilities: `Search`, `Write`, `Long-term memory`

## Required Submission Assets
- App name
- Logo
- Description
- Company URL
- Privacy policy URL
- MCP server URL
- Tool inventory
- Screenshots
- Test prompts
- Test responses
- Localization details

## Review Readiness
- The MCP server must be reachable without extra internal network steps.
- The reviewer account should be able to authenticate with no MFA surprises.
- The same public endpoint should remain stable across app versions.
- Test prompts should show search, brief building, compaction, and handoff behavior.

## Suggested Review Prompts
- Find the last design decision from the current workspace and summarize it.
- Build a context brief for this task from prior sessions.
- Save a lesson when a repeated mistake appears.
- Show the current context pressure and whether compaction is needed.

## Suggested Review Responses
- The plugin recalls prior work instead of restarting from zero.
- The plugin exposes a compact context brief and checkpoint recovery path.
- The plugin shows visible pressure state so the session can compact before overflow.

## Launch Path
1. Keep the packaged self-hosted paths verified and version-pinned.
2. Build a separately authenticated public MCP service with a stable URL and tenant boundary.
3. Publish the required privacy, terms, support, and deletion surfaces.
4. Fill out the OpenAI dashboard submission form.
5. Submit for review and publish only after approval.

## Docs To Keep In Sync
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/SYSTEM_MAP.md`
- `docs/DECISIONS.md`
- `docs/RUNBOOK.md`
