import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const root = new URL('../../../../packages/dsh-plugin/', import.meta.url);

describe('installable DSH bundle', () => {
  it('declares dsh.bundle and ships every referenced runtime file', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
      name: string;
      dsh?: { bundle?: { patch?: string } };
    };
    expect(manifest.name).toBe('@agent-trade/dsh-integration');
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
    expect(existsSync(new URL('cordis.patch.yml', root))).toBe(true);
    expect(existsSync(new URL('runtime/server.mjs', root))).toBe(true);
    expect(existsSync(new URL('runtime/schemas/deal.schema.json', root))).toBe(true);
    expect(existsSync(new URL('policy.json', root))).toBe(true);
    expect(existsSync(new URL('skills/agent-trade/SKILL.md', root))).toBe(true);
    expect(readFileSync(new URL('plugin.mjs', root), 'utf8')).toBe(
      readFileSync(new URL('../plugin.mjs', import.meta.url), 'utf8'),
    );
    expect(readFileSync(new URL('tool-spec.json', root), 'utf8')).toBe(
      readFileSync(new URL('../tool-spec.json', import.meta.url), 'utf8'),
    );
  });

  it('mounts tools and an isolated packaged-skill provider', () => {
    const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8');
    expect(patch).toContain("name: '@agent-trade/dsh-integration'");
    expect(patch).toContain('id: agent-trade-tools');
    expect(patch).toContain('id: agent-trade-skills');
    expect(patch).toContain('providerName: agent-trade');
    expect(patch).toContain("node_modules/@agent-trade/dsh-integration/skills/");
    expect(patch).not.toContain('AGENT_TRADE_REPO');
  });
});
