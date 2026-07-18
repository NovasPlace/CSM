export interface MigrationArtifact {
  path: string;
  sha256: string;
  sourceSha256?: string;
}

export const MIGRATION_ARTIFACTS: Readonly<Record<string, readonly MigrationArtifact[]>> = {
  '20260709-002-session': [artifact('src/schema/session-schema.ts', '4c69e0317cd51efb83a280afcdde01ccb72b8e3722a4f476ef050c4d265a57f3')],
  '20260709-003-memory': [
    artifact('src/schema/memory-schema.ts', 'a16b912109ece64d72c13cb7a279ae2991dd6640afbbb3bd523876b33d0b3058', 'e1599a9374ed713d2a41d16692e6bb3669b6e5cfced78c33d5453f48b88a8df9'),
    artifact('src/schema/memory-embedding-contract.ts', 'bfced3721f8f310ee56c7db072dc2743716135f86372d20831b0f5b40364372c', 'b67f8cf2602c63e37655b3e965aae699c122d8f52e3c2da7aaad7ef4a1561e35'),
    artifact('src/schema/memory-table-schema.ts', '82e35d9381659c3040b12a4c1cc5aac3cda74c512725cd832c6f7b03c82a66bd', '7eb6381e6fbf5964e5f3809990e6863ae962d2d7b5c515a4fe5158f99d45f6ea'),
    artifact('src/schema/memory-support-schema.ts', '9a650343461f04a547f79a78bc3aaab9b323154494d22582b07f512c8173cf3d', '18ace11bbb5f8c3d9c81c145c3bd2450fd74eb7f1aed6d06eaf6729e083116f1'),
    artifact(
      'src/embeddings.ts',
      'cc668cc041bc38510dbd72970ae697b11bae3470186a3da94781f4c9bc7f936b',
      '3ccf20fbe761ba020ef74913eee0a749e60719c516c9af23a0595e23721af93c',
    ),
  ],
  '20260709-004-core': [artifact('src/schema/core-schema.ts', 'f7ac5f2b0aa8892cc4b8c168a0a3e4d1e60fbc42afff917a4b0c9540aaeee233', '2dade867455651b8157909b48df246af8c777377f5d2c3f7a2feef474a2c9b5b')],
  '20260709-005-project-isolation': [artifact('src/schema/project-isolation-schema.ts', '68fd8d3b61e8ce98a73212679fecf0a8b8b1bd994940a9936d36bb9a6ac0b8d4')],
  '20260709-006-checkpoint': [artifact('src/checkpoint-schema.ts', 'd54dc7ab1a63fae3a838b5b2839c2a3bc5e386249e6ee7720f41aadae1f515e7', '728deba8fa9a1e570d57a1c1d2181d387166eb5c004ca12d9107146c083b39ed')],
  '20260709-007-context-compilation': [artifact('src/context-compilation-schema.ts', '8ba4536dba69a5e4940e34af9670fd4f4764b250f9ba610d7f5feab02ee9425c')],
  '20260709-008-context-cache': [artifact('src/context-cache-schema.ts', '0d20a6fbd00c3e6cb28bd85bee4be70f18dccd09b465a46044ea9e03a2ad6f56')],
  '20260709-009-rollover': [artifact('src/context-rollover-schema.ts', 'bff3a9ff39a19b3314db75a095a7fdedc9607390c967a3a4e998a40ffaccb328')],
  '20260709-010-goal': [artifact('src/goal-schema.ts', '31f9026dbfb0a6638d5fcd837dd89c0c46d2e69fc9dcb272f1fbb78456d393bd')],
  '20260709-011-recall-telemetry': [artifact('src/recall-telemetry.ts', '6187f301ddc5ec53ce23ddf1c54a7ce9a5bce3fd780d1d26b4e684c8f41d7b49', 'ead8159c1a9e5a56ba8e1e64f43d9f4409ca3e0476db54aa6cb43b57167aa943')],
  '20260709-012-self-continuity': [artifact('src/self-continuity-schema.ts', '37c68790e05e1631be1d2d0cef3750cfb3eb3d8048d48091540dc18e104d7985', '9248e823b035dda56237dfcc2cde2421385fc90534b88f952178c614d0c5ab95')],
  '20260709-013-cross-session-causal': [artifact('src/cross-session-causal-schema.ts', '7f218b2922a70d4efc3013a1c249d6310ebe231a78a51e5900a09dc63cea0b22')],
  '20260709-014-trace-vault': [artifact('src/trace-vault-store.ts', '6d611dd20fdbba2ae6124e9beecab4df6a1fe1a0e67611b2fd93f6d63685bf27', '58bd827117d51bbf875f95d4f1b1363168dd9b7e7c6b3433881276598b0c8a0c')],
  '20260709-015-graph': [artifact('src/memory-graph.ts', '6abbdc0df6f4de9f37a51125f6202c86b46a13abd39a6346338cf33d3d631e26', '8de93a2776d7c92aed43c4095f288e63c9809d00496e8df86a518e124ef58a40')],
  '20260709-016-work-journal': [artifact('src/work-journal-schema.ts', '0ee97be5f1d22dc1e7cc28c89f506ad9ff935ee3bab188cd2f5b285ca049cc7b', 'e32fda1eddacbd23fb220263f808efee6dd1eafc07663035f1a3d9658943aaec')],
  '20260709-017-candidate-queue': [artifact('src/candidate-schema.ts', 'dfef177f0163f995838f6a0b4543bd91b1e38da55d7c304a681b97b1dbc93237', '0b596e6e330c0bb8303ad329df4c176d8d8071febcbd51e14fac82d9410c7446')],
  '20260709-018-experience-packet': [artifact('src/experience-packet-schema.ts', 'da1d7c15373e6d66663c8c0549b76ca0860c443b2e378244a1390147961b0e41', '5f935f3dd043057d2620ef70ae417bea496f3095d4dac23e790de5b3837ce1ff')],
  '20260709-019-self-model': [artifact('src/self-model-schema.ts', 'abbfd6058a9607382d975d08bd570126c87b2a7dda1c33b7fd2fbde5a69a0a0a', '0570333a3fb3606bfe49e9b6e3fa01c09a42e85a1debbcb5ab4f921240181f63')],
  '20260709-020-belief-knowledge': [artifact('src/belief-knowledge-schema.ts', 'f03c4b3e654d9a933687a8a9a9e165318d916d43b3c7a6db040d0dc8f552356d', 'eb6ece31a2579e7c0edbdfbc6cb181357da792ed9deb7b17e84a6c500f94089d')],
  '20260710-021-work-ledger': [artifact('src/work-ledger-schema.ts', '2c8c256dbb6ad19e2db47a07ccd1b16397eebb3f8eae039eb92ace1fc203670e')],
  '20260710-022-coordination-persistence': [
    artifact('src/coordination-persistence/schema.ts', '5f3416106cd2bc6a9ac79885be9f7eb5106712b13aa36581e68c931b9b6da3fa'),
    artifact('src/coordination-persistence/schema-workspace.ts', 'd1c1ae3da95fee94ba7eee81b16acdf2f712e7b71ab95374abd52a03e4dcad2c'),
    artifact('src/coordination-persistence/schema-assignment.ts', 'b22b20db916b3baf8126934b88166a8336b585be6683be8c1018207e0e916830'),
    artifact('src/coordination-persistence/schema-claims.ts', 'c5006e39336c40f97b763e9c0c106ab3f575592ca6abf0486cef819247703da3'),
    artifact('src/coordination-persistence/schema-artifacts.ts', 'fa1141c365db37278801ca54a75953ce41bdbaba7e564be752c3448b3113640d'),
    artifact('src/coordination-persistence/schema-governance.ts', '5aa8b0d99a812e4851df2ef0cfb949f7ff1adb746eb60626db3e478735cc577e'),
    artifact('src/coordination-persistence/schema-events.ts', '55d80eb6f1fb2359d9fb67438077f7fa624555b76da110527fec55ae1149fe6f'),
  ],
  '20260709-001-sqlite-baseline': [
    artifact('src/schema/sqlite/index.ts', 'b126bd14bcfd30aae52b21920c4c54504da6eb39283ae7a06eed1d12fb485397'),
    artifact('src/schema/sqlite/core.ts', '93a0ec5f7966106be96a8691c62649b8457e3d62d608dcce5a33d0ea22fd7611'),
    artifact('src/schema/sqlite/memory-support.ts', 'e18608e690523604f32c71f6280db0e90d34afe75406c6496c7ee611299c823e'),
    artifact('src/schema/sqlite/events.ts', 'b8cfcd01a12298659648d0dc0a521e1f327846659f67c17b7935bf6ca8c6cb83'),
    artifact('src/schema/sqlite/living-state.ts', '84a1c55325084a6e99fd885e1e9c2afc7fa063ed2957db049a0921e61aca6ce0'),
  ],
  '20260711-002-sqlite-work-journal': [
    artifact('src/schema/sqlite/work-journal.ts', 'e7ec43457c0f8909dd50ee131effbe10111fc24d8881c72b86d04b42849d789e'),
  ],
  '20260711-023-capability-provenance-rewrite': [
    artifact('src/schema/capability-provenance-migration.ts', 'f42646c5e692d7011f7517d9401903f332b4fde9c5a7492d6e1383e862732cb4'),
  ],
  '20260711-024-sqlite-compaction-metrics': [
    artifact('src/schema/sqlite/compaction-metrics.ts', '11ad9b60093c9795e5fe48df0819ddbaaf707d2d3d632d24e4ec70051ff94498'),
    artifact('src/schema/sqlite/compaction-metrics-migration.ts', '6ecc2ba2c371e344acbb81f61ade02dea27a75855ae659ab2fb13a4181cb5a64'),
  ],
  '20260712-024-context-injection-telemetry': [
    artifact('src/schema/context-injection-telemetry-schema.ts', 'ef3d8eba8c0da7c94d89d63bf59dee1b61cc278b9396b810156c414354c27a0f'),
  ],
  '20260712-025-sqlite-context-injection-telemetry': [
    artifact('src/schema/context-injection-telemetry-schema.ts', 'ef3d8eba8c0da7c94d89d63bf59dee1b61cc278b9396b810156c414354c27a0f'),
  ],
  '20260713-025-agentbook': [
    artifact('src/schema/agentbook-schema.ts', '09fa9b9c1545cc358bd06e5356f49b7baab518fa49e0f107fa361c4877a064e3'),
  ],
  '20260718-026-postgres-embedding-dimension': [
    artifact(
      'src/schema/embedding-dimension-migration.ts',
      '33124f555b7eb8b2893529f857e13f6f155dd211497aed9b3b129824c060ce58',
      '420c4c55db208592c769af2bbe5ca06bc3446854c2bc9c33f8d6cb4a88e2d143',
    ),
  ],
  '20260718-027-postgres-embedding-dimension-repair': [
    artifact('src/schema/embedding-dimension-migration.ts', '420c4c55db208592c769af2bbe5ca06bc3446854c2bc9c33f8d6cb4a88e2d143'),
  ],
  '20260713-026-sqlite-agentbook': [
    artifact('src/schema/agentbook-schema.ts', '09fa9b9c1545cc358bd06e5356f49b7baab518fa49e0f107fa361c4877a064e3'),
  ],
};

export function artifactsFor(migrationId: string): readonly string[] {
  const artifacts = MIGRATION_ARTIFACTS[migrationId];
  if (!artifacts) throw new Error(`No immutable artifacts registered for ${migrationId}`);
  return artifacts.map(({ path, sha256, sourceSha256 }) =>
    `${path}:sha256:${sourceSha256 ?? sha256}`);
}

export function legacyArtifactsFor(
  migrationId: string,
  fallback: readonly string[] = [],
): readonly string[] {
  const artifacts = MIGRATION_ARTIFACTS[migrationId];
  if (!artifacts) return fallback;
  return artifacts.map(({ path, sha256 }) => `${path}:sha256:${sha256}`);
}

function artifact(path: string, sha256: string, sourceSha256?: string): MigrationArtifact {
  return { path, sha256, sourceSha256 };
}
