# RUNBOOK.md

## Build Commands

```bash
# Install dependencies
npm install

# Type-check
npm run typecheck

# Lint
npm run lint

# Build (compile TypeScript)
npm run build

# Clean build artifacts
npm run clean
```

---

## Test Commands

```bash
# Unit tests (Vitest)
npm test

# Run specific test file
node --experimental-strip-types --test test/auto-docs.test.ts

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

---

## Database Setup

### Local PostgreSQL (Docker)
```bash
docker run -d \
  --name opencode-memory \
  -e POSTGRES_USER=opencode_memory \
  -e POSTGRES_PASSWORD=opencode_memory \
  -e POSTGRES_DB=opencode_memory \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

### Local PostgreSQL (Native)
```bash
# Create user & DB
psql -U postgres -c "CREATE USER opencode_memory WITH PASSWORD 'opencode_memory';"
psql -U postgres -c "CREATE DATABASE opencode_memory OWNER opencode_memory;"
psql -U postgres -d opencode_memory -c "CREATE EXTENSION vector;"
```

### Connection String
```bash
export DATABASE_URL="postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory"
```

---

## Smoke Tests

```bash
# 1. Verify PostgreSQL connection
psql "$DATABASE_URL" -c "SELECT 1;"

# 2. Verify pgvector extension
psql "$DATABASE_URL" -c "SELECT extname FROM pg_extension WHERE extname = 'vector';"

# 3. Verify tables exist
psql "$DATABASE_URL" -c "\dt"

# 4. Verify migrations applied
psql "$DATABASE_URL" -c "SELECT * FROM schema_migrations ORDER BY applied_at;"

# 5. Test plugin load (in OpenCode)
# Add to opencode.json:
# {
#   "plugins": ["./cross-session-memory"]
# }
# Then: opencode --plugin ./cross-session-memory

# 6. Test memory write/read
# In OpenCode session: save a memory, then search it
```

---

## Recovery Steps

### PostgreSQL Down
```bash
# Check status
docker ps -a | grep opencode-memory
# or
systemctl status postgresql

# Restart
docker restart opencode-memory
# or
systemctl restart postgresql
```

### Migration Failed / Schema Drift
```bash
# Check migration status
psql "$DATABASE_URL" -c "SELECT * FROM schema_migrations;"

# Manual migration (if needed)
psql "$DATABASE_URL" -f src/migrations/001_initial.sql
```

### Memory Corruption / Bad Data
```bash
# Soft reset: delete memories, keep schema
psql "$DATABASE_URL" -c "TRUNCATE memories, distillation_log, project_identity;"

# Hard reset: drop & recreate
psql -U postgres -c "DROP DATABASE opencode_memory;"
psql -U postgres -c "CREATE DATABASE opencode_memory OWNER opencode_memory;"
psql -U postgres -d opencode_memory -c "CREATE EXTENSION vector;"
# Plugin will re-run migrations on next load
```

### Plugin Not Loading
```bash
# Check OpenCode plugin path
opencode plugin list

# Verify build output exists
ls -la dist/

# Check TypeScript errors
npm run typecheck

# Check plugin entry point
cat dist/index.js | head -20
```

---

## Public Release Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes (100% critical path coverage)
- [ ] `node --experimental-strip-types --test test/auto-docs.test.ts` passes
- [ ] `npm run build` produces clean `dist/`
- [ ] Migration `001_initial.sql` runs on fresh DB
- [ ] Smoke tests pass on fresh DB
- [ ] `package.json` version bumped
- [ ] `CHANGELOG.md` updated (not CHANGELOG_LIVE.md)
- [ ] README.md has install/config instructions
- [ ] Publish: `npm publish`