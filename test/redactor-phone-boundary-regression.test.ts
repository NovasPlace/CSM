import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../dist/redactor.js';

describe('Redactor phone-number identifier boundaries', () => {
  const redactor = new Redactor({ categories: { path: 'off' } });

  it('does not redact a phone-shaped fragment embedded in an alphanumeric identifier', () => {
    const input = 'artifact abc555-123-4567 should remain intact';
    const result = redactor.redact(input);

    assert.equal(result.audit.byCategory.phone, 0);
    assert.equal(result.text, input);
  });

  it('still redacts the same phone shape at a real text boundary', () => {
    const input = 'Call 555-123-4567 for support';
    const result = redactor.redact(input);

    assert.equal(result.audit.byCategory.phone, 1);
    assert.ok(result.text.includes('[REDACTED_PHONE]'));
  });
});
