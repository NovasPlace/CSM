# CHANGELOG_LIVE.md

## Development Log

### 2026-06-28 - Security review note
- Local Defender alert most plausibly matched a risky PowerShell install flow in PSReadLine history: `curl -fsSL https://opencode.ai/install | bash`.
- Repo source scan did not show a Trojan signature or an obvious payload in first-party files.
- Desktop ZIPs inspected as workspace exports, not executables: `cross-session-memory.zip` is a normal repo export and `cross-session-memory (2).zip` is a fuller workspace snapshot.
- `.codex-remote-attachments/` only contains JPEG screenshots used in the review thread.
