import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  formatDoctorReport,
  inspectRuntime,
  isSupportedNodeVersion,
  redactDoctorError,
  reportOverall,
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
} from '../src/doctor.js';

describe('CSM Doctor support contract', () => {
  it('enforces the published Node.js compatibility range', () => {
    assert.equal(isSupportedNodeVersion('22.22.1'), false);
    assert.equal(isSupportedNodeVersion('22.22.2'), true);
    assert.equal(isSupportedNodeVersion('23.9.0'), false);
    assert.equal(isSupportedNodeVersion('24.14.9'), false);
    assert.equal(isSupportedNodeVersion('24.15.0'), true);
    assert.equal(isSupportedNodeVersion('25.9.0'), false);
    assert.equal(isSupportedNodeVersion('26.0.0'), true);
    assert.equal(isSupportedNodeVersion('27.0.0'), true);
    assert.equal(isSupportedNodeVersion('not-a-version'), false);
    assert.equal(inspectRuntime('22.22.1').status, 'fail');
  });

  it('fails on blockers, warns on hardening findings, and ignores skipped optional probes', () => {
    const check = (status: DoctorCheck['status']): DoctorCheck => ({
      id: 'runtime', status, summary: status,
    });
    assert.equal(reportOverall([check('pass'), check('skip')]), 'pass');
    assert.equal(reportOverall([check('pass'), check('warn')]), 'warn');
    assert.equal(reportOverall([check('warn'), check('fail')]), 'fail');
  });

  it('redacts connection credentials, API keys, and bearer values', () => {
    const databaseUrl = 'postgresql://buyer:database-secret@db.example/csm';
    const ollamaUrl = 'https://buyer:ollama-secret@ollama.example';
    const message = redactDoctorError(
      new Error(`failed ${databaseUrl} ${ollamaUrl} api_key=provider-secret Authorization: Bearer bearer-secret`),
      {
        CSM_DATABASE_URL: databaseUrl,
        OPENAI_API_KEY: 'provider-secret',
        OLLAMA_HOST: ollamaUrl,
      },
    );
    assert.doesNotMatch(message, /database-secret|ollama-secret|provider-secret|bearer-secret/u);
    assert.match(message, /\[REDACTED\]/u);
  });

  it('formats an actionable human report without customer data', () => {
    const report: DoctorReport = {
      schemaVersion: 1,
      product: 'Cross-Session Memory',
      version: '1.0.0',
      checkedAt: '2026-07-18T00:00:00.000Z',
      overall: 'warn',
      onlineProbe: false,
      checks: [{
        id: 'security', status: 'warn', summary: 'Production hardening required.',
        action: 'Enable retention.',
      }],
      privacy: 'No credentials or memory content are included in this report.',
    };
    const output = formatDoctorReport(report);
    assert.match(output, /CSM Doctor 1\.0\.0: WARN/u);
    assert.match(output, /Next: Enable retention\./u);
    assert.match(output, /No credentials or memory content/u);
  });

  it('performs an explicit bounded Ollama model and dimension probe', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'csm-doctor-online-'));
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    try {
      const config = {
        ...DEFAULT_CONFIG,
        databaseProvider: 'sqlite' as const,
        sqlitePath: join(directory, 'missing.sqlite'),
        embeddingApiKey: undefined,
        embeddingApiUrl: `http://127.0.0.1:${address.port}`,
        embeddingModel: 'doctor-test-model',
        embeddingDimensions: 3,
      };
      const report = await runDoctor({
        cwd: directory,
        online: true,
        nodeVersion: '26.0.0',
        loadConfig: async () => config,
      });
      const embedding = report.checks.find((check) => check.id === 'embeddings');
      assert.equal(embedding?.status, 'pass');
      assert.equal(embedding?.details?.dimensions, 3);
      assert.equal(report.checks.find((check) => check.id === 'database')?.status, 'fail');
    } finally {
      server.close();
      await once(server, 'close');
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
