export interface MigrationArtifact {
  path: string;
  sha256: string;
}

export const MIGRATION_ARTIFACTS: Readonly<Record<string, readonly MigrationArtifact[]>> = {
  '20260709-002-session': [artifact('src/schema/session-schema.ts', '4c69e0317cd51efb83a280afcdde01ccb72b8e3722a4f476ef050c4d265a57f3')],
  '20260709-003-memory': [
    artifact('src/schema/memory-schema.ts', 'a16b912109ece64d72c13cb7a279ae2991dd6640afbbb3bd523876b33d0b3058'),
    artifact('src/schema/memory-embedding-contract.ts', 'bfced3721f8f310ee56c7db072dc2743716135f86372d20831b0f5b40364372c'),
    artifact('src/schema/memory-table-schema.ts', '82e35d9381659c3040b12a4c1cc5aac3cda74c512725cd832c6f7b03c82a66bd'),
    artifact('src/schema/memory-support-schema.ts', '9a650343461f04a547f79a78bc3aaab9b323154494d22582b07f512c8173cf3d'),
    artifact('src/embeddings.ts', 'cc668cc041bc38510dbd72970ae697b11bae3470186a3da94781f4c9bc7f936b'),
  ],
  '20260709-004-core': [artifact('src/schema/core-schema.ts', 'f7ac5f2b0aa8892cc4b8c168a0a3e4d1e60fbc42afff917a4b0c9540aaeee233')],
  '20260709-005-project-isolation': [artifact('src/schema/project-isolation-schema.ts', '68fd8d3b61e8ce98a73212679fecf0a8b8b1bd994940a9936d36bb9a6ac0b8d4')],
  '20260709-006-checkpoint': [artifact('src/checkpoint-schema.ts', 'd54dc7ab1a63fae3a838b5b2839c2a3bc5e386249e6ee7720f41aadae1f515e7')],
  '20260709-007-context-compilation': [artifact('src/context-compilation-schema.ts', '8ba4536dba69a5e4940e34af9670fd4f4764b250f9ba610d7f5feab02ee9425c')],
  '20260709-008-context-cache': [artifact('src/context-cache-schema.ts', '0d20a6fbd00c3e6cb28bd85bee4be70f18dccd09b465a46044ea9e03a2ad6f56')],
  '20260709-009-rollover': [artifact('src/context-rollover-schema.ts', 'bff3a9ff39a19b3314db75a095a7fdedc9607390c967a3a4e998a40ffaccb328')],
  '20260709-010-goal': [artifact('src/goal-schema.ts', '31f9026dbfb0a6638d5fcd837dd89c0c46d2e69fc9dcb272f1fbb78456d393bd')],
  '20260709-011-recall-telemetry': [artifact('src/recall-telemetry.ts', '6187f301ddc5ec53ce23ddf1c54a7ce9a5bce3fd780d1d26b4e684c8f41d7b49')],
  '20260709-012-self-continuity': [artifact('src/self-continuity-schema.ts', '37c68790e05e1631be1d2d0cef3750cfb3eb3d8048d48091540dc18e104d7985')],
  '20260709-013-cross-session-causal': [artifact('src/cross-session-causal-schema.ts', '7f218b2922a70d4efc3013a1c249d6310ebe231a78a51e5900a09dc63cea0b22')],
  '20260709-014-trace-vault': [artifact('src/trace-vault-store.ts', '6d611dd20fdbba2ae6124e9beecab4df6a1fe1a0e67611b2fd93f6d63685bf27')],
  '20260709-015-graph': [artifact('src/memory-graph.ts', '6abbdc0df6f4de9f37a51125f6202c86b46a13abd39a6346338cf33d3d631e26')],
  '20260709-016-work-journal': [artifact('src/work-journal-schema.ts', '0ee97be5f1d22dc1e7cc28c89f506ad9ff935ee3bab188cd2f5b285ca049cc7b')],
  '20260709-017-candidate-queue': [artifact('src/candidate-schema.ts', 'dfef177f0163f995838f6a0b4543bd91b1e38da55d7c304a681b97b1dbc93237')],
  '20260709-018-experience-packet': [artifact('src/experience-packet-schema.ts', 'da1d7c15373e6d66663c8c0549b76ca0860c443b2e378244a1390147961b0e41')],
  '20260709-019-self-model': [artifact('src/self-model-schema.ts', 'abbfd6058a9607382d975d08bd570126c87b2a7dda1c33b7fd2fbde5a69a0a0a')],
  '20260709-020-belief-knowledge': [artifact('src/belief-knowledge-schema.ts', 'f03c4b3e654d9a933687a8a9a9e165318d916d43b3c7a6db040d0dc8f552356d')],
  '20260710-021-work-ledger': [artifact('src/work-ledger-schema.ts', '2c8c256dbb6ad19e2db47a07ccd1b16397eebb3f8eae039eb92ace1fc203670e')],
  '20260709-001-sqlite-baseline': [
    artifact('src/schema/sqlite/index.ts', 'b126bd14bcfd30aae52b21920c4c54504da6eb39283ae7a06eed1d12fb485397'),
    artifact('src/schema/sqlite/core.ts', '93a0ec5f7966106be96a8691c62649b8457e3d62d608dcce5a33d0ea22fd7611'),
    artifact('src/schema/sqlite/memory-support.ts', 'e18608e690523604f32c71f6280db0e90d34afe75406c6496c7ee611299c823e'),
    artifact('src/schema/sqlite/events.ts', 'b8cfcd01a12298659648d0dc0a521e1f327846659f67c17b7935bf6ca8c6cb83'),
    artifact('src/schema/sqlite/living-state.ts', '84a1c55325084a6e99fd885e1e9c2afc7fa063ed2957db049a0921e61aca6ce0'),
  ],
};

export function artifactsFor(migrationId: string): readonly string[] {
  const artifacts = MIGRATION_ARTIFACTS[migrationId];
  if (!artifacts) throw new Error(`No immutable artifacts registered for ${migrationId}`);
  return artifacts.map(({ path, sha256 }) => `${path}:sha256:${sha256}`);
}

function artifact(path: string, sha256: string): MigrationArtifact {
  return { path, sha256 };
}
