# Configuration Reliability Contract

CSM configuration is validated before the affected runtime starts. Valid defaults remain unchanged,
but malformed explicit input is rejected instead of being silently coerced or ignored.

## Parsing rules

- Boolean values accept `true` or `false`, case-insensitively. Values such as `yes`, `1`, or an
  empty string fail with the variable name.
- Integer fields require finite whole numbers. Fractional counts, durations, sizes, and limits fail.
- Numeric threshold fields accept finite decimal or scientific notation. Trailing text, hexadecimal,
  `NaN`, and infinity fail.
- Parsed numeric values are then checked against field-specific semantic ranges. Timer intervals,
  output sizes, capture limits, percentages, and counts cannot silently accept unsafe negative,
  zero, overflow-prone, or out-of-policy values. The existing `ttl.defaultDays` ceiling remains 365.
- A present `.env` file supports comments, `export KEY=value`, quoted values, and unquoted inline
  comments. Invalid variable names, missing separators, unterminated quotes, or unexpected trailing
  text fail with a line number. Values are never included in parse errors.
- Existing process environment values take precedence over `.env` values.

## Retention safety

- TTL values define eligibility; cleanup is not an automatic startup task.
- Cleanup requires a project, previews by default, and mutates data only with explicit `apply=true`.
- The longest matching type, importance-band, or grace-period duration wins.
- Applied runs are capped at 1,000 memories by default and 10,000 maximum.
- Default importance retention is 30 days for low, 90 for medium, and 180 for high importance.
- Database cleanup does not erase separate exports, generated documents, logs, or backups. See
  [Data Privacy and Lifecycle](DATA_PRIVACY_AND_LIFECYCLE.md).

## Provider prerequisites

- `CSM_DATABASE_PROVIDER` is `postgres` or `sqlite` only.
- PostgreSQL URLs must use the `postgres:` or `postgresql:` scheme.
- `CSM_REQUIRE_EXPLICIT_DATABASE_URL=true` requires `CSM_DATABASE_URL` for PostgreSQL. It does not
  impose a PostgreSQL URL on the legacy SQLite execution path.
- SQLite paths must be non-empty and cannot contain NUL characters.
- PostgreSQL startup ignores SQLite-only path variables, and SQLite startup ignores PostgreSQL-only
  pool and TLS variables. An invalid inactive-provider setting cannot block the selected backend.
- `CSM_EMBEDDING_PROVIDER=openai` requires a non-empty `OPENAI_API_KEY`.
- Ollama endpoints must be valid HTTP or HTTPS URLs.

## Regression evidence

`test/config-strict-parsing.test.ts` covers valid dotenv syntax, malformed records, secret-safe errors,
strict booleans, exact decimal parsing, integer rejection, provider prerequisites, and the PostgreSQL
versus SQLite explicit-URL boundary. Existing provider and re-entry configuration tests protect valid
defaults and backend capability gating.

This contract does not make SQLite a Coordination Fabric backend. Coordination Fabric remains
PostgreSQL-only; SQLite remains supported only for the documented legacy CSM path.
