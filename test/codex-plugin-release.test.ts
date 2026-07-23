import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();

describe('portable Codex plugin release', () => {
  it('ships a verified one-command installer without developer paths or secrets', () => {
    const installer = read('release-assets/codex-plugin-windows/install.ps1');
    const builder = read('scripts/build-codex-plugin-release.mjs');
    assert.match(installer, /Assert-BundleIntegrity/u);
    assert.match(installer, /MANIFEST\.sha256/u);
    assert.match(installer, /CSM_DATABASE_PROVIDER=sqlite/u);
    assert.match(installer, /CSM_CONFIG_DIR/u);
    assert.match(installer, /plugin marketplace add/u);
    assert.match(installer, /plugin add/u);
    assert.doesNotMatch(installer, /C:\\Users\\Donovan/iu);
    assert.match(builder, /delete runtimeManifest\.configurationDirectory/u);
    assert.match(builder, /Developer-machine path leaked/u);
    assert.match(builder, /Secret-like file is forbidden/u);
  });

  it('keeps the portable launcher and marketplace contract aligned', () => {
    const launcher = read('plugins/cross-session-memory-bridge/scripts/launch-mcp.mjs');
    const mcp = JSON.parse(read('plugins/cross-session-memory-bridge/.mcp.json')) as {
      mcpServers: Record<string, { env_vars: string[] }>;
    };
    const server = mcp.mcpServers['cross-session-memory-bridge'];
    assert.ok(server.env_vars.includes('CSM_CONFIG_DIR'));
    assert.match(launcher, /CrossSessionMemory.*config/su);
    assert.match(launcher, /existsSync\(path\.join\(configDirectory, '\.env'\)\)/u);
  });

  it('exposes repeatable build and isolated verification commands', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert.match(packageJson.scripts['plugin:release:windows'], /build-codex-plugin-release/u);
    assert.match(packageJson.scripts['plugin:release:verify:windows'], /verify-codex-plugin-release/u);
  });
});

function read(relative: string): string {
  return readFileSync(join(ROOT, ...relative.split('/')), 'utf8');
}
