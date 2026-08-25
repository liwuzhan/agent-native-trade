import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const pluginRoot = join(repoRoot, 'packages', 'codex-plugin');
const runtime = join(pluginRoot, 'runtime', 'mcp-server.mjs.br');
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('Codex plugin package', () => {
  it('has a self-consistent manifest, marketplace, and skill', () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
    const mcp = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'));
    const marketplace = JSON.parse(readFileSync(join(repoRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    const skill = readFileSync(join(pluginRoot, 'skills', 'agent-native-trade', 'SKILL.md'), 'utf8');

    expect(manifest.name).toBe('agent-native-trade');
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.skills).toBe('./skills/');
    expect(manifest.mcpServers).toBe('./.mcp.json');
    expect(mcp['agent-trade'].command).toBe('node');
    expect(mcp['agent-trade'].args[0]).toBe('-e');
    expect(mcp['agent-trade'].args[1]).toContain("'plugins','cache','agent-native-trade','agent-native-trade'");
    expect(mcp['agent-trade'].args.join(' ')).not.toContain('${PLUGIN_ROOT}');
    expect(marketplace.plugins[0].source.source).toBe('local');
    expect(marketplace.plugins[0].source.path).toBe('./packages/codex-plugin');
    expect(skill).toMatch(/^---\nname: agent-native-trade\ndescription: .+\n---/);
    expect(existsSync(runtime)).toBe(true);
  });

  it('starts the bundled MCP server, exposes all tools, and creates an identity', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-trade-codex-'));
    const codexHome = mkdtempSync(join(tmpdir(), 'agent-trade-codex-home-'));
    const installedPlugin = join(
      codexHome,
      'plugins',
      'cache',
      'agent-native-trade',
      'agent-native-trade',
      '0.2.0',
    );
    mkdirSync(installedPlugin, { recursive: true });
    symlinkSync(join(pluginRoot, 'runtime'), join(installedPlugin, 'runtime'), 'dir');
    symlinkSync(join(pluginRoot, 'policy.json'), join(installedPlugin, 'policy.json'), 'file');
    const mcp = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'))['agent-trade'];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: mcp.args,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        AGENT_TRADE_DATA_DIR: dataDir,
        AGENT_TRADE_RUNTIME_CACHE: join(codexHome, 'runtime-cache'),
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'codex-plugin-test', version: '0.2.0' });
    cleanups.push(async () => {
      await client.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    });
    await client.connect(transport);

    const toolSpec = JSON.parse(
      readFileSync(join(repoRoot, 'integrations', 'deepseek-harness', 'plugin', 'tool-spec.json'), 'utf8'),
    );
    const expectedNames = toolSpec.tools.map((tool: { name: string }) => tool.name).sort();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(expectedNames);
    expect(listed.tools).toHaveLength(23);

    const result = await client.callTool({
      name: 'trade_identity_create',
      arguments: { agentId: 'codex_test' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: true });
    const summary = JSON.parse((result.structuredContent as { summary: string }).summary);
    expect(summary).toMatchObject({ agentId: 'codex_test' });
    expect(summary.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
