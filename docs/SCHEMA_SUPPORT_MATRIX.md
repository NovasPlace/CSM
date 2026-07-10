# Schema Support Matrix

CSM uses forward-only schema initialization. A backup is required before every release upgrade; application rollback does not reverse DDL.

| Provider | Starting schema | Target | Status | Executable evidence |
|---|---|---|---|---|
| PostgreSQL | `legacy-unversioned` | `csm-postgres-v2` | Supported | `schema-migration-upgrade.test.ts` preserves a legacy session and enables current writes |
| PostgreSQL | `csm-postgres-v1` | `csm-postgres-v2` | Supported | `work-ledger-migration-upgrade.test.ts` applies only migration 21 and preserves the first 20 checksums |
| PostgreSQL | `csm-postgres-v2` | `csm-postgres-v2` | Supported replay | `schema-migration-upgrade.test.ts` proves idempotent startup and 21 immutable ledger rows |
| SQLite | no ledger or `csm-sqlite-v1` | `csm-sqlite-v1` | Supported | `sqlite-schema-bootstrap.test.ts` proves bootstrap and idempotent replay |
| Either | unknown future migration | current release | Rejected | `migration-ledger.test.ts` proves fail-fast history validation |
| Either | other provider's ledger | current provider | Rejected | `migration-ledger.test.ts` proves provider-bound history validation |

Only the rows marked supported are in the current compatibility window. Adding a schema release requires a new immutable migration identifier, a fixture for the previous supported version, and a matrix test before release.

## Roll-forward and application rollback

1. Take and verify a custom-format backup with `npm run drill:backup-restore`.
2. Stop writers or place the application in maintenance mode.
3. Deploy the newer application; startup applies pending migrations transactionally.
4. Verify `Database.diagnose().readiness.status === 'pass'` and inspect `csm_schema_migrations`.
5. If application behavior fails but schema remains compatible, roll the application back.
6. If the older application rejects the new migration history or is schema-incompatible, restore the pre-upgrade backup into a new database and repoint the application. Do not manually delete ledger rows or reverse DDL in place.
