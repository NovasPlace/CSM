/**
 * Phase 18: Privacy/Redaction Layer
 *
 * Redacts sensitive content BEFORE persistence, embeddings, checkpoints,
 * context cache, distilled summaries, and Alchemist lesson storage.
 *
 * Design rules:
 *  - Redact before storage, never after.
 *  - Secure by default; categories opt-out via config.
 *  - Audit metadata contains counts ONLY — never raw redacted values.
 *  - Paths are normalized (not blindly redacted) to preserve coding utility:
 *      C:\Users\ExampleUser\project\src/foo.ts → [WORKSPACE]/src/foo.ts
 *  - Fail-closed: on error, return input with safe redaction applied.
 */
import { posix, win32 } from 'node:path';

export type RedactCategory =
  | 'secret'
  | 'email'
  | 'phone'
  | 'ip'
  | 'urlCreds'
  | 'path';

export type PathMode = 'normalize' | 'redact' | 'off';

export interface RedactorConfig {
  enabled: boolean;
  categories: {
    secret: boolean;
    email: boolean;
    phone: boolean;
    ip: boolean;
    urlCreds: boolean;
    path: PathMode;
  };
  workspaceRoot?: string;
}

export interface RedactionAudit {
  totalRedacted: number;
  byCategory: Record<RedactCategory, number>;
}

export interface RedactionResult {
  text: string;
  audit: RedactionAudit;
  changed: boolean;
}

export const DEFAULT_REDACTOR_CONFIG: RedactorConfig = {
  enabled: true,
  categories: {
    secret: true,
    email: true,
    phone: true,
    ip: true,
    urlCreds: true,
    path: 'normalize',
  },
};

const MARKERS: Record<RedactCategory, string> = {
  secret: '[REDACTED_SECRET]',
  email: '[REDACTED_EMAIL]',
  phone: '[REDACTED_PHONE]',
  ip: '[REDACTED_IP]',
  urlCreds: '[REDACTED_URL]',
  path: '[REDACTED_PATH]',
};

// ── Patterns ──────────────────────────────────────────────────────────

// API keys / tokens — common formats: prefix + 20+ chars, hex, base64
const SECRET_PATTERNS: RegExp[] = [
  // Generic API key patterns (sk-..., gh-..., xox..., AKIA..., etc.)
  // Allow hyphens in the key body (sk-proj-..., xoxb-...-...)
  /\b(?:sk|sk-proj|sk-ant|ghp|gho|ghu|ghs|ghr|xox[baprs]|AIza|tfp|tfg|dop_v1|dop_v2|opencode_)[-_]?[A-Za-z0-9-]{20,}\b/g,
  // AWS access keys: AKIA + 16 uppercase alphanumeric
  /\bAKIA[A-Z0-9]{16,}\b/g,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9\-_.]{20,}/g,
  // Private keys (PEM blocks)
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  // Generic long hex/base64 tokens assigned to key-like names
  /\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key|client[_-]?secret|password|passwd|pwd)["'\s:=]+["']?([A-Za-z0-9+/=_-]{32,})["']?/gi,
  // JWT tokens
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Connection strings with embedded passwords
  /(?:postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp|mysql|wss?):\/\/[^:\s]+:[^@\s]+@/g,
];

// Email addresses
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Phone numbers (US + international basic)
const PHONE_PATTERN = /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

// IP addresses (IPv4 only; IPv6 is rare in code context)
const IP_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

// URLs with credentials or sensitive query params
const URL_CRED_PATTERN = /\bhttps?:\/\/[^:\s]+:[^@\s]+@[^\s/]+/g;
const URL_QUERY_SECRET_PATTERN = /([?&](?:api[_-]?key|token|secret|password|access[_-]?token|private[_-]?key|client[_-]?secret)=[^&\s]+)/gi;

// Absolute filesystem paths (Windows + POSIX)
const QUOTED_WIN_PATH_PATTERN = /(["'])(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"'<>|\r\n]+[\\/][^\\/:*?"'<>|\r\n]+[\\/])[^"'<>|\r\n]+\1/g;
const WIN_PATH_PATTERN = /(?:[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|]+(?: (?![A-Za-z]:)[^\s\\/:*?"<>|]+)*[\\/])*[^\s\\/:*?"<>|]+(?: (?![A-Za-z]:)[^\s\\/:*?"<>|]+)*|\\\\[^\s\\/:*?"<>|]+[\\/][^\s\\/:*?"<>|]+(?:[\\/][^\s\\/:*?"<>|]+)*)/g;
const QUOTED_POSIX_PATH_PATTERN = /(["'])\/(?:home|Users|root|var|opt|etc|tmp|usr|mnt|srv|data|www|private|Volumes|Library|Applications)(?:\/[^"'\r\n]+)+\1/g;
const POSIX_PATH_PATTERN = /\/(?:home|Users|root|var|opt|etc|tmp|usr|mnt|srv|data|www|private|Volumes|Library|Applications)(?:\/[^\s:*?"<>|]+(?: [^\s:*?"<>|]+)*)+/g;

// ── Redactor class ────────────────────────────────────────────────────

export class Redactor {
  private config: RedactorConfig;
  private workspaceRoot: string | null;

  constructor(config?: Partial<RedactorConfig>) {
    this.config = { ...DEFAULT_REDACTOR_CONFIG, ...config };
    if (config?.categories) {
      this.config.categories = { ...DEFAULT_REDACTOR_CONFIG.categories, ...config.categories };
    }
    // `path: 'normalize'` is meaningless without a root: normalizePath() falls straight
    // through to the [REDACTED_PATH] marker for EVERY path when workspaceRoot is unset,
    // silently turning the default 'normalize' mode into 'redact'. DEFAULT_REDACTOR_CONFIG
    // ships 'normalize' but no default root, so that is what every caller which never sets
    // one has been getting. Fall back to the process working directory so the documented
    // behaviour holds out of the box. Paths outside the root are still redacted, as intended.
    this.workspaceRoot = this.config.workspaceRoot || process.cwd();
  }

  /**
   * Redact sensitive content from text.
   * Returns redacted text + audit (counts only, never raw values).
   * Fail-closed: on error, returns input with conservative redaction.
   */
  redact(text: string): RedactionResult {
    if (!this.config.enabled) {
      return { text, audit: emptyAudit(), changed: false };
    }

    try {
      return this.redactUnsafe(text);
    } catch {
      // Fail-closed: redact everything we safely can
      return this.failClosed(text);
    }
  }

  /**
   * Redact a value whose schema identifies it as a filesystem path.
   *
   * Free-form text is intentionally not treated as one whole path: a command
   * such as `/usr/bin/node --version` or a slash command such as `/review` is
   * ambiguous. Callers with a real path field can use this method so unquoted
   * paths containing spaces are still protected without erasing commands.
   */
  redactPath(text: string): RedactionResult {
    if (!this.config.enabled || this.config.categories.path === 'off') {
      return this.redact(text);
    }

    try {
      const trimmed = text.trim();
      if (!isAbsolutePath(trimmed)) return this.redact(text);

      const pathMode = this.config.categories.path;
      const replacement = pathMode === 'redact' ? MARKERS.path : this.normalizePath(trimmed);
      const start = text.indexOf(trimmed);
      const protectedText = `${text.slice(0, start)}${replacement}${text.slice(start + trimmed.length)}`;
      const result = this.redactUnsafe(protectedText);

      if (replacement !== trimmed) {
        result.audit.byCategory.path++;
        result.audit.totalRedacted++;
        result.changed = true;
      }
      return result;
    } catch {
      return this.failClosed(text);
    }
  }

  /**
   * Redact an object's string keys and values (deep).
   * Returns the object with redacted strings + aggregated audit.
   */
  redactObject<T>(obj: T): { result: T; audit: RedactionAudit } {
    const audit = emptyAudit();
    const result = this.redactStringsDeep(obj, audit);
    return { result, audit };
  }

  private redactUnsafe(text: string): RedactionResult {
    const audit = emptyAudit();
    let result = text;

    if (this.config.categories.secret) {
      result = this.applyPatterns(result, SECRET_PATTERNS, 'secret', audit);
    }
    if (this.config.categories.urlCreds) {
      result = this.applyPattern(result, URL_CRED_PATTERN, 'urlCreds', audit);
      result = this.applyPattern(result, URL_QUERY_SECRET_PATTERN, 'urlCreds', audit);
    }
    if (this.config.categories.email) {
      result = this.applyPattern(result, EMAIL_PATTERN, 'email', audit);
    }
    if (this.config.categories.phone) {
      result = this.applyPattern(result, PHONE_PATTERN, 'phone', audit);
    }
    if (this.config.categories.ip) {
      result = this.applyPattern(result, IP_PATTERN, 'ip', audit);
    }

    // Paths: normalize, redact, or leave alone
    const pathMode = this.config.categories.path;
    if (pathMode === 'redact') {
      result = this.applyPattern(result, QUOTED_WIN_PATH_PATTERN, 'path', audit);
      result = this.applyPattern(result, QUOTED_POSIX_PATH_PATTERN, 'path', audit);
      result = this.applyPattern(result, WIN_PATH_PATTERN, 'path', audit);
      result = this.applyPattern(result, POSIX_PATH_PATTERN, 'path', audit);
    } else if (pathMode === 'normalize') {
      result = this.normalizePaths(result, audit);
    }

    return {
      text: result,
      audit,
      changed: audit.totalRedacted > 0,
    };
  }

  private applyPattern(
    text: string,
    pattern: RegExp,
    category: RedactCategory,
    audit: RedactionAudit,
  ): string {
    const globalPattern = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g');
    let count = 0;
    const result = text.replace(globalPattern, () => {
      count++;
      return MARKERS[category];
    });
    audit.byCategory[category] += count;
    audit.totalRedacted += count;
    return result;
  }

  private applyPatterns(
    text: string,
    patterns: RegExp[],
    category: RedactCategory,
    audit: RedactionAudit,
  ): string {
    let result = text;
    for (const p of patterns) {
      result = this.applyPattern(result, p, category, audit);
    }
    return result;
  }

  private normalizePaths(text: string, audit: RedactionAudit): string {
    let count = 0;

    const replacePath = (match: string): string => {
      const normalized = this.normalizePath(match);
      if (normalized !== match) {
        count++;
        return normalized;
      }
      return match;
    };

    const replaceQuotedPath = (match: string): string => {
      const quote = match[0];
      const inner = match.slice(1, -1);
      const normalized = this.normalizePath(inner);
      if (normalized !== inner) count++;
      return `${quote}${normalized}${quote}`;
    };

    let result = text.replace(QUOTED_WIN_PATH_PATTERN, replaceQuotedPath);
    result = result.replace(QUOTED_POSIX_PATH_PATTERN, replaceQuotedPath);
    result = result.replace(WIN_PATH_PATTERN, replacePath);
    result = result.replace(POSIX_PATH_PATTERN, replacePath);

    audit.byCategory.path += count;
    audit.totalRedacted += count;
    return result;
  }

  private normalizePath(absPath: string): string {
    if (!this.workspaceRoot) {
      // No workspace root configured — redact to marker
      return MARKERS.path;
    }

    const rootStyle = pathStyle(this.workspaceRoot);
    const inputStyle = pathStyle(absPath);

    // Different path families can never share a containment boundary.
    if (rootStyle !== inputStyle) {
      return MARKERS.path;
    }

    const pathApi = rootStyle === 'windows' ? win32 : posix;
    const resolvedRoot = pathApi.resolve(this.workspaceRoot);
    const resolvedInput = pathApi.resolve(absPath);
    const relative = pathApi.relative(resolvedRoot, resolvedInput);
    const isWithinWorkspace = relative === '' || (
      relative !== '..'
      && !relative.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relative)
    );

    if (isWithinWorkspace) {
      const portableRelative = relative.split(pathApi.sep).join('/');
      return portableRelative ? `[WORKSPACE]/${portableRelative}` : '[WORKSPACE]';
    }

    // Outside workspace — redact
    return MARKERS.path;
  }

  private redactStringsDeep<T>(obj: T, audit: RedactionAudit): T {
    if (typeof obj === 'string') {
      const r = this.redact(obj);
      audit.byCategory.secret += r.audit.byCategory.secret;
      audit.byCategory.email += r.audit.byCategory.email;
      audit.byCategory.phone += r.audit.byCategory.phone;
      audit.byCategory.ip += r.audit.byCategory.ip;
      audit.byCategory.urlCreds += r.audit.byCategory.urlCreds;
      audit.byCategory.path += r.audit.byCategory.path;
      audit.totalRedacted += r.audit.totalRedacted;
      return r.text as unknown as T;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactStringsDeep(item, audit)) as unknown as T;
    }
    if (obj && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const keyResult = this.redact(key);
        mergeAudit(audit, keyResult.audit);
        let safeKey = keyResult.text;
        let suffix = 2;
        while (Object.prototype.hasOwnProperty.call(result, safeKey)) {
          safeKey = `${keyResult.text}#${suffix}`;
          suffix++;
        }
        Object.defineProperty(result, safeKey, {
          value: this.redactStringsDeep(value, audit),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result as unknown as T;
    }
    return obj;
  }

  private failClosed(text: string | null | undefined): RedactionResult {
    if (!text) {
      return { text: '', audit: emptyAudit(), changed: false };
    }
    const audit = emptyAudit();
    let result = text;

    // Conservative: redact secrets and connection strings at minimum
    for (const p of SECRET_PATTERNS) {
      result = this.applyPattern(result, p, 'secret', audit);
    }

    return {
      text: result,
      audit,
      changed: audit.totalRedacted > 0,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function emptyAudit(): RedactionAudit {
  return {
    totalRedacted: 0,
    byCategory: {
      secret: 0,
      email: 0,
      phone: 0,
      ip: 0,
      urlCreds: 0,
      path: 0,
    },
  };
}

function mergeAudit(target: RedactionAudit, source: RedactionAudit): void {
  target.byCategory.secret += source.byCategory.secret;
  target.byCategory.email += source.byCategory.email;
  target.byCategory.phone += source.byCategory.phone;
  target.byCategory.ip += source.byCategory.ip;
  target.byCategory.urlCreds += source.byCategory.urlCreds;
  target.byCategory.path += source.byCategory.path;
  target.totalRedacted += source.totalRedacted;
}

function pathStyle(value: string): 'windows' | 'posix' {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) return 'windows';
  if (value.startsWith('/')) return 'posix';
  return process.platform === 'win32' ? 'windows' : 'posix';
}

function isAbsolutePath(value: string): boolean {
  if (!value || /[\r\n"']/.test(value)) return false;
  return pathStyle(value) === 'windows' ? win32.isAbsolute(value) : posix.isAbsolute(value);
}

/**
 * Convenience function: redact a string with default config.
 */
export function redact(text: string, config?: Partial<RedactorConfig>): RedactionResult {
  return new Redactor(config).redact(text);
}

/**
 * Convenience function: redact an object's string values with default config.
 */
export function redactObject<T>(obj: T, config?: Partial<RedactorConfig>): { result: T; audit: RedactionAudit } {
  return new Redactor(config).redactObject(obj);
}

/**
 * Normalize a value exactly as JSON persistence would, then redact each string
 * key and value structurally. This preserves valid JSON even when a secret occurs
 * in a URL query and preserves Date/toJSON behavior that a direct object walk loses.
 */
export function redactJsonValue<T>(redactor: Redactor, value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  const normalized = JSON.parse(serialized) as T;
  return redactor.redactObject(normalized).result;
}
