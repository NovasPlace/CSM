import { jsonExtractText, type QueryDialect } from './db/query-dialect.js';
import type { DatabasePool } from './types.js';

export const REQUIRED_MEMORY_PROVENANCE_FIELDS = [
  'source_kind',
  'evidence_strength',
  'source_session_id',
  'source_agent_id',
  'source_model_id',
  'source_surface',
] as const;

export type RequiredMemoryProvenanceField =
  (typeof REQUIRED_MEMORY_PROVENANCE_FIELDS)[number];

export interface MemoryProvenanceAuditReport {
  totalMemories: number;
  activeMemories: number;
  completeProvenance: number;
  rowsWithAnyGap: number;
  activeRowsWithAnyGap: number;
  missingByField: Record<RequiredMemoryProvenanceField, number>;
  unknownModelIdRows: number;
  defaultModelIdRows: number;
  activeUnknownModelIdRows: number;
  activeDefaultModelIdRows: number;
}

type QueryTarget = Pick<DatabasePool, 'query'>;

function blankToNull(expression: string): string {
  return `NULLIF(TRIM(COALESCE(${expression}, '')), '')`;
}

function effectiveFieldExpressions(
  dialect: QueryDialect,
): Record<RequiredMemoryProvenanceField, string> {
  const metadataField = (field: RequiredMemoryProvenanceField) =>
    blankToNull(jsonExtractText(dialect, 'metadata', field));

  return {
    source_kind: metadataField('source_kind'),
    evidence_strength: metadataField('evidence_strength'),
    source_session_id: `COALESCE(${metadataField('source_session_id')}, ${blankToNull('session_id')})`,
    source_agent_id: metadataField('source_agent_id'),
    source_model_id: metadataField('source_model_id'),
    source_surface: metadataField('source_surface'),
  };
}

export function buildMemoryProvenanceAuditSql(dialect: QueryDialect): string {
  const fields = effectiveFieldExpressions(dialect);
  const anyGap = REQUIRED_MEMORY_PROVENANCE_FIELDS
    .map((field) => `${fields[field]} IS NULL`)
    .join(' OR ');
  const active = 'superseded_by IS NULL AND archived_at IS NULL';
  const modelId = fields.source_model_id;

  const missingCounts = REQUIRED_MEMORY_PROVENANCE_FIELDS
    .map((field) => `COALESCE(SUM(CASE WHEN ${fields[field]} IS NULL THEN 1 ELSE 0 END), 0) AS missing_${field}`)
    .join(',\n    ');

  return `
    SELECT
      COUNT(*) AS total_memories,
      COALESCE(SUM(CASE WHEN ${active} THEN 1 ELSE 0 END), 0) AS active_memories,
      COALESCE(SUM(CASE WHEN NOT (${anyGap}) THEN 1 ELSE 0 END), 0) AS complete_provenance,
      COALESCE(SUM(CASE WHEN ${anyGap} THEN 1 ELSE 0 END), 0) AS rows_with_any_gap,
      COALESCE(SUM(CASE WHEN ${active} AND (${anyGap}) THEN 1 ELSE 0 END), 0) AS active_rows_with_any_gap,
      ${missingCounts},
      COALESCE(SUM(CASE WHEN LOWER(${modelId}) = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_model_id_rows,
      COALESCE(SUM(CASE WHEN LOWER(${modelId}) = 'default' THEN 1 ELSE 0 END), 0) AS default_model_id_rows,
      COALESCE(SUM(CASE WHEN ${active} AND LOWER(${modelId}) = 'unknown' THEN 1 ELSE 0 END), 0) AS active_unknown_model_id_rows,
      COALESCE(SUM(CASE WHEN ${active} AND LOWER(${modelId}) = 'default' THEN 1 ELSE 0 END), 0) AS active_default_model_id_rows
    FROM memories
  `;
}

function count(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export async function auditMemoryProvenance(
  pool: QueryTarget,
  dialect: QueryDialect,
): Promise<MemoryProvenanceAuditReport> {
  const result = await pool.query(buildMemoryProvenanceAuditSql(dialect));
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;

  const missingByField = Object.fromEntries(
    REQUIRED_MEMORY_PROVENANCE_FIELDS.map((field) => [
      field,
      count(row, `missing_${field}`),
    ]),
  ) as Record<RequiredMemoryProvenanceField, number>;

  return {
    totalMemories: count(row, 'total_memories'),
    activeMemories: count(row, 'active_memories'),
    completeProvenance: count(row, 'complete_provenance'),
    rowsWithAnyGap: count(row, 'rows_with_any_gap'),
    activeRowsWithAnyGap: count(row, 'active_rows_with_any_gap'),
    missingByField,
    unknownModelIdRows: count(row, 'unknown_model_id_rows'),
    defaultModelIdRows: count(row, 'default_model_id_rows'),
    activeUnknownModelIdRows: count(row, 'active_unknown_model_id_rows'),
    activeDefaultModelIdRows: count(row, 'active_default_model_id_rows'),
  };
}
