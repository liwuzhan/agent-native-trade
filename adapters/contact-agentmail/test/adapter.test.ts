import { describe, expect, it, vi } from 'vitest';
import { createAgentMailAdapter, parseAgentMailEvent, type WebSocketLike } from '../src/index.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  closed: [number | undefined, string | undefined] | undefined;
  listeners = new Map<string, Array<(event: { data?: unknown; code?: number }) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = [code, reason];
    this.fire('close', { code });
  }

  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown; code?: number }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: string, event: { data?: unknown; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('AgentMail REST adapter', () => {
  it('sends with correlation metadata without exposing credentials in the body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message_id: 'msg_sent', thread_id: 'thread_1' }));
    const adapter = createAgentMailAdapter({
      apiKey: 'secret-key',
      inboxId: 'seller@example.net',
      fetch: fetchMock as typeof fetch,
    });

    const result = await adapter.send({
      inboxId: 'seller@example.net',
      to: 'buyer@example.net',
      subject: 'Offer',
      text: 'Hello',
      tradeId: 'trade_1',
    });

    expect(result).toMatchObject({ ref: { messageId: 'msg_sent' }, threadId: 'thread_1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.agentmail.to/v0/inboxes/seller%40example.net/messages/send');
    expect(JSON.parse(init.body as string)).toMatchObject({
      to: ['buyer@example.net'],
      headers: { 'X-Trade-Id': 'trade_1' },
    });
    expect(init.body).not.toContain('secret-key');
  });

  it('refuses a message that declares a size beyond the configured limit', async () => {
    const adapter = createAgentMailAdapter({
      apiKey: 'key',
      inboxId: 'seller@example.net',
      maxMessageBytes: 100,
      fetch: (async () => jsonResponse({
        message_id: 'msg_1',
        from: 'buyer@example.net',
        to: ['seller@example.net'],
        text: 'oversized',
        size: 101,
      })) as typeof fetch,
    });
    await expect(adapter.getMessage({
      provider: 'agentmail',
      inboxId: 'seller@example.net',
      messageId: 'msg_1',
    })).rejects.toThrow('size limit');
  });

  it('bounds the JSON response before parsing a message body', async () => {
    const adapter = createAgentMailAdapter({
      apiKey: 'key',
      inboxId: 'seller@example.net',
      maxMessageBytes: 100,
      fetch: (async () => new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String(2 * 1024 * 1024) },
      })) as typeof fetch,
    });
    await expect(adapter.getMessage({
      provider: 'agentmail',
      inboxId: 'seller@example.net',
      messageId: 'msg_1',
    })).rejects.toThrow('response exceeds configured limit');
  });

  it('returns status-only API errors so a key cannot leak through URLs or bodies', async () => {
    const adapter = createAgentMailAdapter({
      apiKey: 'secret-key',
      inboxId: 'seller@example.net',
      fetch: (async () => new Response('secret-key echoed by upstream', { status: 401 })) as typeof fetch,
    });
    const health = await adapter.health();
    expect(health).toEqual({
      ok: false,
      provider: 'agentmail',
      detail: 'AgentMail API request failed (401)',
    });
  });
});

describe('AgentMail WebSocket adapter', () => {
  it('subscribes and emits metadata-only events from the live wire envelope', async () => {
    const socket = new FakeSocket();
    let openedUrl = '';
    const adapter = createAgentMailAdapter({
      apiKey: 'secret-key',
      inboxId: 'seller@example.net',
      websocketFactory: (url) => {
        openedUrl = url;
        return socket;
      },
    });
    const events: unknown[] = [];
    const watcher = await adapter.watch({ inboxIds: ['seller@example.net'] }, async (event) => {
      events.push(event);
    });

    socket.fire('open');
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: 'subscribe',
      inboxIds: ['seller@example.net'],
      eventTypes: ['message.received'],
    });
    expect(new URL(openedUrl).searchParams.get('api_key')).toBe('secret-key');

    socket.fire('message', { data: JSON.stringify({
      type: 'event',
      eventType: 'message.received',
      eventId: 'evt_1',
      message: {
        messageId: 'msg_1',
        inboxId: 'seller@example.net',
        threadId: 'thread_1',
        from: 'buyer@example.net',
        subject: 'Inquiry',
        text: 'this must not be forwarded',
        headers: { 'X-Trade-Id': 'trade_1' },
        timestamp: '2026-08-24T00:00:00.000Z',
        size: 321,
      },
    }) });
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toEqual([expect.objectContaining({
      eventId: 'evt_1',
      from: 'buyer@example.net',
      tradeId: 'trade_1',
      trust: 'untrusted',
    })]);
    expect(JSON.stringify(events)).not.toContain('this must not be forwarded');
    await watcher.close();
  });

  it('fails done after connectTimeoutMs when the socket never opens', async () => {
    const socket = new FakeSocket();
    const adapter = createAgentMailAdapter({
      apiKey: 'secret-key',
      inboxId: 'seller@example.net',
      connectTimeoutMs: 15,
      websocketFactory: () => socket,
    });

    const watcher = await adapter.watch({ inboxIds: ['seller@example.net'] }, async () => {});
    // no 'open' is ever fired — the socket is stuck in CONNECTING
    await expect(watcher.done).rejects.toThrow('connect timeout');
    // the abandoned socket was closed, not leaked
    expect(socket.closed).toBeDefined();
    // the failed watcher is unregistered
    expect(await adapter.close()).toBeUndefined();
  });
});

describe('parseAgentMailEvent compatibility', () => {
  it('accepts the documented SDK-style discriminant and snake_case message fields', () => {
    expect(parseAgentMailEvent({
      type: 'message_received',
      event_id: 'evt_2',
      message: {
        message_id: 'msg_2',
        inbox_id: 'seller@example.net',
        from: { email: 'buyer@example.net' },
        received_at: '2026-08-24T00:00:00.000Z',
      },
    })).toMatchObject({ eventId: 'evt_2', inboxId: 'seller@example.net' });
  });

  it('ignores acknowledgements and unrelated events', () => {
    expect(parseAgentMailEvent({ type: 'subscribed' })).toBeUndefined();
    expect(parseAgentMailEvent({ type: 'event', eventType: 'thread.updated' })).toBeUndefined();
  });
});
