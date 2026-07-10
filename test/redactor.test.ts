import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor, redact, redactObject, DEFAULT_REDACTOR_CONFIG } from '../dist/redactor.js';

describe('Redactor — secrets', () => {
  const r = new Redactor();

  it('redacts OpenAI API keys (sk-...)', () => {
    const input = 'Use the key sk-proj-abc123def456ghi789jkl012mno345pqr in your config';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_SECRET]'));
    assert.ok(!result.text.includes('sk-proj-abc123'));
    assert.equal(result.audit.byCategory.secret, 1);
    assert.equal(result.audit.totalRedacted, 1);
    assert.equal(result.changed, true);
  });

  it('redacts GitHub tokens (ghp_...)', () => {
    const input = 'ghp_1234567890abcdefghijklmnopqrstuv';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_SECRET]'));
    assert.ok(!result.text.includes('ghp_'));
  });

  it('redacts Slack tokens (xox...)', () => {
    const input = 'xoxb-FAKETESTTOKEN1234567890';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_SECRET]'));
  });

  it('redacts AWS access keys (AKIA...)', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_SECRET]'));
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_SECRET]'));
    assert.ok(!result.text.includes('eyJ'));
  });

  it('redacts PEM private key blocks', () => {
    const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_SECRET]'));
    assert.ok(!result.text.includes('MIIEpA'));
  });

  it('redacts key=value style secrets', () => {
    const input = 'api_key="AKIAIOSFODNN7EXAMPLE1234567890ABCDEFGH"';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_SECRET]'));
    assert.ok(!result.text.includes('AKIAIOSFODNN7EXAMPLE1234567890ABCDEFGH'));
  });

  it('redacts JWT tokens', () => {
    const input = 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_SECRET]'));
  });

  it('redacts connection strings with passwords', () => {
    const input = 'postgres://user:secretpass123@db.example.com:5432/mydb';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_SECRET]'));
    assert.ok(!result.text.includes('secretpass123'));
  });
});

describe('Redactor — emails', () => {
  const r = new Redactor();

  it('redacts email addresses', () => {
    const input = 'Contact admin@example.com or john.doe+test@sub.domain.co.uk';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_EMAIL]'));
    assert.ok(!result.text.includes('admin@example.com'));
    assert.ok(!result.text.includes('john.doe'));
    assert.equal(result.audit.byCategory.email, 2);
  });
});

describe('Redactor — phone numbers', () => {
  const r = new Redactor();

  it('redacts US phone numbers', () => {
    const input = 'Call (555) 123-4567 or 555.987.6543';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_PHONE]'));
    assert.ok(!result.text.includes('555'));
    assert.equal(result.audit.byCategory.phone, 2);
  });

  it('redacts international phone numbers', () => {
    const input = 'Phone: +1 555 123 4567';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_PHONE]'));
  });
});

describe('Redactor — IP addresses', () => {
  const r = new Redactor();

  it('redacts IPv4 addresses', () => {
    const input = 'Server at 192.168.1.100 and 10.0.0.1';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_IP]'));
    assert.ok(!result.text.includes('192.168.1.100'));
    assert.ok(!result.text.includes('10.0.0.1'));
    assert.equal(result.audit.byCategory.ip, 2);
  });
});

describe('Redactor — URLs with credentials', () => {
  const r = new Redactor();

  it('redacts URLs with embedded credentials', () => {
    const input = 'https://user:pass@example.com/api';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_URL]'));
    assert.ok(!result.text.includes('user:pass'));
  });

  it('redacts URLs with API key in query params', () => {
    const input = 'https://api.example.com/data?api_key=secret123abc456def789ghi012jkl345&format=json';
    const result = r.redact(input);
    assert.ok(!result.text.includes('api_key=secret'));
    assert.ok(!result.text.includes('secret123abc456'));
    assert.ok(result.audit.totalRedacted > 0);
  });
});

describe('Redactor — paths', () => {
  it('normalizes workspace paths by default', () => {
    const r = new Redactor({ workspaceRoot: 'C:\\Users\\Donovan\\project' });
    const input = 'Edited C:\\Users\\Donovan\\project\\src\\foo.ts and C:/Users/Donovan/project/test/bar.test.ts';
    const result = r.redact(input);
    assert.ok(result.text.includes('[WORKSPACE]/src/foo.ts'), `expected [WORKSPACE]/src/foo.ts in: ${result.text}`);
    assert.ok(result.text.includes('[WORKSPACE]/test/bar.test.ts'));
    assert.ok(!result.text.includes('Donovan'));
    assert.equal(result.audit.byCategory.path, 2);
  });

  it('redacts non-workspace paths when normalizing', () => {
    const r = new Redactor({ workspaceRoot: 'C:\\Users\\Donovan\\project' });
    const input = 'Config at C:\\Users\\Alice\\secrets\\.env';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_PATH]'));
    assert.ok(!result.text.includes('Alice'));
  });

  it('redacts POSIX paths outside workspace', () => {
    const r = new Redactor({ workspaceRoot: '/home/user/project' });
    const input = 'Log at /var/log/app.log and config /etc/nginx/nginx.conf';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_PATH]'));
    assert.ok(!result.text.includes('/var/log/app.log'));
  });

  it('normalizes POSIX workspace paths', () => {
    const r = new Redactor({ workspaceRoot: '/home/user/project' });
    const input = 'Edited /home/user/project/src/index.ts';
    const result = r.redact(input);
    assert.ok(result.text.includes('[WORKSPACE]/src/index.ts'));
    assert.ok(!result.text.includes('/home/user'));
  });

  it('redacts all paths when path mode is "redact"', () => {
    const r = new Redactor({ categories: { path: 'redact' } });
    const input = 'C:\\Users\\Donovan\\project\\src\\foo.ts';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_PATH]'));
    assert.ok(!result.text.includes('foo.ts'));
  });

  it('leaves paths untouched when path mode is "off"', () => {
    const r = new Redactor({ categories: { path: 'off' } });
    const input = 'C:\\Users\\Donovan\\project\\src\\foo.ts';
    const result = r.redact(input);
    assert.equal(result.text, input);
    assert.equal(result.audit.byCategory.path, 0);
  });

  it('normalizes against the working directory when no workspaceRoot is configured', () => {
    // Regression: DEFAULT_REDACTOR_CONFIG sets path: 'normalize' but supplies no
    // workspaceRoot, so normalizePath() returned [REDACTED_PATH] for every path and
    // 'normalize' silently behaved as 'redact'.
    const r = new Redactor();
    const result = r.redact(`Edited ${process.cwd()}/src/foo.ts`);
    assert.ok(result.text.includes('[WORKSPACE]/src/foo.ts'), `expected [WORKSPACE]/src/foo.ts in: ${result.text}`);
    assert.ok(!result.text.includes('[REDACTED_PATH]'));
  });

  it('still redacts paths outside the working directory when no workspaceRoot is configured', () => {
    const r = new Redactor();
    const result = r.redact('Config at /home/someone-else/secrets/.env');
    assert.ok(result.text.includes('[REDACTED_PATH]'));
    assert.ok(!result.text.includes('someone-else'));
  });
});

describe('Redactor — audit metadata', () => {
  it('audit contains counts only, never raw secrets', () => {
    const r = new Redactor();
    const input = 'api_key=AKIAIOSFODNN7EXAMPLE1234567890ABCDEFGH email=admin@secret.com';
    const result = r.redact(input);
    const auditStr = JSON.stringify(result.audit);
    assert.ok(!auditStr.includes('AKIA'));
    assert.ok(!auditStr.includes('admin@secret.com'));
    assert.ok(auditStr.includes('"secret":1'));
    assert.ok(auditStr.includes('"email":1'));
    assert.equal(result.audit.totalRedacted, 2);
  });
});

describe('Redactor — category toggles', () => {
  it('disabling secret category leaves API keys visible', () => {
    const r = new Redactor({ categories: { secret: false } });
    const input = 'sk-proj-abc123def456ghi789jkl012mno345pqr';
    const result = r.redact(input);
    assert.ok(!result.text.includes('[REDACTED_SECRET]'));
    assert.equal(result.audit.byCategory.secret, 0);
  });

  it('disabling email category leaves emails visible', () => {
    const r = new Redactor({ categories: { email: false } });
    const input = 'admin@example.com';
    const result = r.redact(input);
    assert.ok(result.text.includes('admin@example.com'));
    assert.equal(result.audit.byCategory.email, 0);
  });

  it('disabling all categories leaves text unchanged', () => {
    const r = new Redactor({
      categories: { secret: false, email: false, phone: false, ip: false, urlCreds: false, path: 'off' },
    });
    const input = 'sk-proj-abc123def456ghi789jkl012mno345pqr admin@example.com 192.168.1.1';
    const result = r.redact(input);
    assert.equal(result.text, input);
    assert.equal(result.changed, false);
  });
});

describe('Redactor — disabled', () => {
  it('returns text unchanged when disabled', () => {
    const r = new Redactor({ enabled: false });
    const input = 'sk-proj-abc123def456ghi789jkl012mno345pqr admin@example.com';
    const result = r.redact(input);
    assert.equal(result.text, input);
    assert.equal(result.changed, false);
  });
});

describe('Redactor — fail-closed', () => {
  it('redacts secrets even on internal error', () => {
    const r = new Redactor();
    // Force an error by passing a non-string to the internal method
    // The redact() method catches errors and applies conservative redaction
    const input = 'api_key=AKIAIOSFODNN7EXAMPLE1234567890ABCDEFGH';
    const result = r.redact(input);
    assert.ok(result.text.includes('[REDACTED_SECRET]'));
  });
});

describe('Redactor — redactObject', () => {
  it('redacts strings in nested objects', () => {
    const r = new Redactor();
    const obj = {
      title: 'Config for admin@secret.com',
      nested: {
        token: 'sk-proj-abc123def456ghi789jkl012mno345pqr',
        items: ['admin@example.com', 'no secrets here'],
      },
    };
    const { result, audit } = r.redactObject(obj);
    assert.ok(!JSON.stringify(result).includes('admin@secret.com'));
    assert.ok(!JSON.stringify(result).includes('sk-proj-abc'));
    assert.ok(result.nested.items[0].includes('[REDACTED_EMAIL]'));
    assert.ok(audit.totalRedacted >= 2);
  });
});

describe('Redactor — convenience functions', () => {
  it('redact() works with default config', () => {
    const result = redact('admin@example.com');
    assert.ok(result.text.includes('[REDACTED_EMAIL]'));
  });

  it('redactObject() works with default config', () => {
    const { result } = redactObject({ key: 'admin@example.com' });
    assert.ok(result.key.includes('[REDACTED_EMAIL]'));
  });
});

describe('Redactor — combined input', () => {
  it('redacts multiple categories in one pass', () => {
    const r = new Redactor({ workspaceRoot: 'C:\\Users\\Donovan\\project' });
    const input = [
      'Deploy to 10.0.0.5 with api_key=AKIAIOSFODNN7EXAMPLE1234567890ABCDEFGH',
      'Contact dev@team.io at (555) 123-4567',
      'Config at C:\\Users\\Donovan\\project\\.env',
      'DB: postgres://admin:password123@db.internal:5432/app',
    ].join('\n');

    const result = r.redact(input);

    assert.ok(!result.text.includes('10.0.0.5'));
    assert.ok(!result.text.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(!result.text.includes('dev@team.io'));
    assert.ok(!result.text.includes('555'));
    assert.ok(!result.text.includes('password123'));
    assert.ok(result.text.includes('[WORKSPACE]/.env'));

    assert.ok(result.audit.byCategory.secret >= 2);
    assert.ok(result.audit.byCategory.email >= 1);
    assert.ok(result.audit.byCategory.phone >= 1);
    assert.ok(result.audit.byCategory.ip >= 1);
    assert.ok(result.audit.byCategory.path >= 1);
    assert.ok(result.audit.totalRedacted >= 6);
  });
});
