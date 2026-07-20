import { randomUUID } from 'node:crypto';
import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import { dialectFromPool, nowFn, type QueryDialect } from './db/query-dialect.js';
import type { AgentBookRule, AgentBookRuleInput } from './agentbook-types.js';
import { Redactor } from './redactor.js';

interface RuleRow {
  rule_id: string;
  scope: string;
  priority: number | string;
  trigger: string | null;
  instruction: string;
  override_policy: string;
  version: number | string;
  active: boolean | number | string;
  created_at: string | Date;
  updated_at: string | Date;
}

export type AgentBookRulePatch = Partial<AgentBookRuleInput>;

function placeholder(_dialect: QueryDialect, index: number): string {
  // SQLite DatabasePool rewrites $N placeholders to ? and preserves parameter order.
  return `$${index}`;
}

function normalizeTimestamp(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function toBoolean(value: RuleRow['active']): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function databaseBoolean(dialect: QueryDialect, value: boolean): boolean | number {
  return dialect === 'sqlite' ? (value ? 1 : 0) : value;
}

function rowToRule(raw: unknown): AgentBookRule {
  const row = raw as RuleRow;
  return {
    ruleId: row.rule_id,
    scope: row.scope as AgentBookRule['scope'],
    priority: Number(row.priority),
    trigger: row.trigger,
    instruction: row.instruction,
    overridePolicy: row.override_policy as AgentBookRule['overridePolicy'],
    version: Number(row.version),
    active: toBoolean(row.active),
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
  };
}

function validateRuleInput(input: AgentBookRuleInput): void {
  if (!input.instruction.trim()) throw new Error('AgentBook rule instruction is required');
  if (input.priority !== undefined && !Number.isInteger(input.priority)) {
    throw new Error('AgentBook rule priority must be an integer');
  }
}

export class AgentBookRulesStore {
  constructor(
    private readonly pool: DatabasePool,
    private readonly redactor: Redactor = new Redactor(),
  ) {}

  async addRule(input: AgentBookRuleInput): Promise<AgentBookRule> {
    validateRuleInput(input);
    const dialect = dialectFromPool(this.pool);
    const ruleId = `rule_${randomUUID()}`;
    const safeTrigger = input.trigger == null ? null : this.redactor.redact(input.trigger).text;
    const safeInstruction = this.redactor.redact(input.instruction).text;
    const values: unknown[] = [
      ruleId,
      input.scope ?? 'project',
      input.priority ?? 0,
      safeTrigger,
      safeInstruction,
      input.overridePolicy ?? 'augment',
      databaseBoolean(dialect, input.active ?? true),
    ];
    const params = values.map((_, index) => placeholder(dialect, index + 1)).join(', ');
    await this.pool.query(
      `INSERT INTO agentbook_rules
         (rule_id, scope, priority, "trigger", instruction, override_policy, active)
       VALUES (${params})`,
      values,
    );
    const rule = await this.getRule(ruleId);
    if (!rule) throw new Error(`AgentBook rule insert could not be read back: ${ruleId}`);
    getLogger().debug(`AgentBook rule added: ${ruleId}`);
    return rule;
  }

  async updateRule(ruleId: string, patch: AgentBookRulePatch): Promise<AgentBookRule> {
    const dialect = dialectFromPool(this.pool);
    const assignments: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = ${placeholder(dialect, values.length)}`);
    };

    if (patch.scope !== undefined) set('scope', patch.scope);
    if (patch.priority !== undefined) {
      if (!Number.isInteger(patch.priority)) throw new Error('AgentBook rule priority must be an integer');
      set('priority', patch.priority);
    }
    if ('trigger' in patch) {
      set('"trigger"', patch.trigger == null ? null : this.redactor.redact(patch.trigger).text);
    }
    if (patch.instruction !== undefined) {
      if (!patch.instruction.trim()) throw new Error('AgentBook rule instruction is required');
      set('instruction', this.redactor.redact(patch.instruction).text);
    }
    if (patch.overridePolicy !== undefined) set('override_policy', patch.overridePolicy);
    if (patch.active !== undefined) set('active', databaseBoolean(dialect, patch.active));
    if (assignments.length === 0) throw new Error('AgentBook rule patch contains no mutable fields');

    assignments.push('version = version + 1');
    assignments.push(`updated_at = ${nowFn(dialect)}`);
    values.push(ruleId);
    const result = await this.pool.query(
      `UPDATE agentbook_rules
       SET ${assignments.join(', ')}
       WHERE rule_id = ${placeholder(dialect, values.length)}`,
      values,
    );
    if ((result.rowCount ?? 0) === 0) throw new Error(`AgentBook rule not found: ${ruleId}`);
    const rule = await this.getRule(ruleId);
    if (!rule) throw new Error(`AgentBook rule update could not be read back: ${ruleId}`);
    getLogger().debug(`AgentBook rule updated: ${ruleId}`);
    return rule;
  }

  async deactivateRule(ruleId: string): Promise<void> {
    await this.updateRule(ruleId, { active: false });
  }

  async listRules(options: {
    scope?: AgentBookRule['scope'];
    active?: boolean;
  } = {}): Promise<AgentBookRule[]> {
    const dialect = dialectFromPool(this.pool);
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      conditions.push(`${column} = ${placeholder(dialect, values.length)}`);
    };
    if (options.scope !== undefined) add('scope', options.scope);
    if (options.active !== undefined) add('active', databaseBoolean(dialect, options.active));
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM agentbook_rules
       ${where}
       ORDER BY priority DESC, updated_at DESC, rule_id ASC`,
      values,
    );
    return result.rows.map((row) => this.sanitizeRule(row));
  }

  async getRule(ruleId: string): Promise<AgentBookRule | null> {
    const dialect = dialectFromPool(this.pool);
    const result = await this.pool.query(
      `SELECT * FROM agentbook_rules WHERE rule_id = ${placeholder(dialect, 1)}`,
      [ruleId],
    );
    return result.rows.length > 0 ? this.sanitizeRule(result.rows[0]) : null;
  }

  async getActiveRules(): Promise<AgentBookRule[]> {
    return this.listRules({ active: true });
  }

  private sanitizeRule(row: unknown): AgentBookRule {
    const rule = rowToRule(row);
    return {
      ...rule,
      trigger: rule.trigger == null ? null : this.redactor.redact(rule.trigger).text,
      instruction: this.redactor.redact(rule.instruction).text,
    };
  }
}
