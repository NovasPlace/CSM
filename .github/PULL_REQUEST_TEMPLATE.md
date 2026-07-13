## Summary

Describe the change in one or two paragraphs.

## Problem and root cause

What failed or was missing? Explain the underlying cause, not only the observed symptom.

## Scope

### Included

- 

### Excluded

- 

## Behavior change

Describe the before-and-after behavior.

## Storage and provider impact

- [ ] No database impact
- [ ] PostgreSQL schema or query impact
- [ ] SQLite schema or query impact
- [ ] Provider tool-surface impact
- [ ] Migration added or changed

Details:

## Continuity and safety impact

- [ ] No re-entry, memory, governance, compaction, or promotion impact
- [ ] Provenance behavior reviewed
- [ ] Context-budget behavior reviewed
- [ ] Preview or enablement boundary reviewed
- [ ] Failure and recovery behavior documented

Details:

## Verification

- [ ] Focused tests pass
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run lint:src`
- [ ] `npm test`
- [ ] `npm run db:setup` when database-sensitive
- [ ] `npm run drill:backup-restore` when persistence-sensitive
- [ ] PostgreSQL and SQLite behavior checked where applicable

Paste relevant output or link to CI:

```text

```

## Documentation

- [ ] README updated
- [ ] Feature map updated
- [ ] Product architecture updated
- [ ] Configuration/provider matrix updated
- [ ] Relevant contract or phase evidence updated
- [ ] No documentation change required

## Risk and rollback

What could regress? How can the change be disabled or reverted without losing durable data?

## Review notes

Call out high-blast-radius files, concurrency assumptions, migration ordering, or intentional follow-up work.
