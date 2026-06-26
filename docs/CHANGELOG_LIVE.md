# CHANGELOG_LIVE.md

## Development Log

### 2026-06-26 — Lesson-recall integration (224 tests)
- `AlchemistLesson` gains required `confidence` and `retention` fields
- `AlchemistEngine.store(lessons)` bulk-loads lessons without a GapReport
- `CompileResult.injectedLessons` exposes which lessons reached the compiled context
- `rankLessons` filters by `confidence >= 0.5` before token-budget ranking
- `compileContextWithLessons()` returns telemetry + injected lessons, making recall observable
- New test file `test/lesson-recall.test.ts` (10 tests) proves the full recall→inject→assert loop
- Docs updated: SYSTEM_MAP.md key decision, this entry
- Total tests: 214 → 224, 0 failures

### 2026-06-24 — Old entry
- old stuff
