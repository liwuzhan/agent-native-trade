import { describe, expect, it } from 'vitest';
import { parseInboxdConfig } from '../src/index.js';

describe('trade-inboxd config', () => {
  it('defaults to queue-only event delivery', () => {
    const config = parseInboxdConfig({
      provider: 'agentmail',
      inboxId: 'seller@example.net',
      apiKeyEnv: 'AGENTMAIL_API_KEY',
    }, '/srv/agent-trade');
    expect(config).toMatchObject({
      dataDir: '/srv/agent-trade/.agent-trade/contact',
      trigger: { mode: 'none' },
      reconnect: { initialMs: 1000, maxMs: 30000 },
    });
  });

  it('resolves command working directories relative to the config file', () => {
    const config = parseInboxdConfig({
      provider: 'agentmail',
      inboxId: 'seller@example.net',
      apiKeyEnv: 'AGENTMAIL_API_KEY',
      trigger: { mode: 'command', argv: ['./wake'], cwd: 'runtime' },
    }, '/srv/agent-trade');
    expect(config.trigger).toMatchObject({ cwd: '/srv/agent-trade/runtime' });
  });

  it('rejects embedded API keys and invalid environment variable names', () => {
    expect(() => parseInboxdConfig({
      provider: 'agentmail',
      inboxId: 'seller@example.net',
      apiKeyEnv: 'KEY=value',
    })).toThrow('environment variable name');
  });
});
