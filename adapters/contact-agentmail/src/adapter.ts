import type {
  AttachmentRef,
  ContactAdapter,
  ContactHealth,
  InboundEvent,
  MessageRef,
  ReplyInput,
  SendInput,
  SentRef,
  StoredMessage,
  WatchHandle,
  WatchInput,
} from '@agent-trade/contact-core';
import { asRecord, getAddress, getNumber, getString, normalizeHeaders, parseAgentMailEvent } from './parse.js';
import type { AgentMailConfig, WebSocketEventLike, WebSocketFactory, WebSocketLike } from './types.js';

const DEFAULT_API_URL = 'https://api.agentmail.to/v0';
const DEFAULT_WEBSOCKET_URL = 'wss://ws.agentmail.to/v0';
const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_JSON_OVERHEAD_BYTES = 1024 * 1024;
const DEFAULT_API_RESPONSE_BYTES = 2 * 1024 * 1024;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function validateHeaderValue(value: string, label: string): void {
  if (value.length > 1024 || /[\r\n]/u.test(value)) throw new Error(`${label} contains invalid characters`);
}

function messageHeaders(headers: Record<string, string> | undefined, tradeId: string | undefined): Record<string, string> {
  const result = { ...(headers ?? {}) };
  for (const [name, value] of Object.entries(result)) {
    validateHeaderValue(name, 'header name');
    validateHeaderValue(value, `header ${name}`);
  }
  if (tradeId) {
    validateHeaderValue(tradeId, 'trade id');
    for (const name of Object.keys(result)) {
      if (name.toLowerCase() === 'x-trade-id') delete result[name];
    }
    result['X-Trade-Id'] = tradeId;
  }
  return result;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' ? [value] : [];
  return value.map(getAddress).filter((item): item is string => Boolean(item));
}

function attachments(value: unknown): AttachmentRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = asRecord(raw);
    const attachmentId = getString(item, 'attachmentId', 'attachment_id', 'id');
    if (!attachmentId) return [];
    const size = getNumber(item, 'size', 'sizeBytes', 'size_bytes');
    return [{
      attachmentId,
      ...(getString(item, 'filename', 'name') ? { filename: getString(item, 'filename', 'name') } : {}),
      ...(getString(item, 'contentType', 'content_type')
        ? { contentType: getString(item, 'contentType', 'content_type') }
        : {}),
      ...(size === undefined ? {} : { size }),
    }];
  });
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const constructor = (globalThis as unknown as { WebSocket?: new (value: string) => WebSocketLike }).WebSocket;
  if (!constructor) throw new Error('Node.js WebSocket is unavailable');
  return new constructor(url);
}

function eventText(event: WebSocketEventLike): string {
  const value = event.data;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  throw new Error('unsupported AgentMail WebSocket message type');
}

export class AgentMailAdapter implements ContactAdapter {
  private readonly apiKey: string;
  private readonly inboxId: string;
  private readonly apiBaseUrl: string;
  private readonly websocketUrl: string;
  private readonly maxMessageBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly websocketFactory: WebSocketFactory;
  private readonly watchers = new Set<WatchHandle>();

  constructor(config: AgentMailConfig) {
    if (!config.apiKey) throw new Error('AgentMail apiKey is required');
    if (!config.inboxId) throw new Error('AgentMail inboxId is required');
    this.apiKey = config.apiKey;
    this.inboxId = config.inboxId;
    this.apiBaseUrl = trimTrailingSlash(config.apiBaseUrl ?? DEFAULT_API_URL);
    this.websocketUrl = config.websocketUrl ?? DEFAULT_WEBSOCKET_URL;
    this.maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (!Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes <= 0) {
      throw new Error('AgentMail maxMessageBytes must be a positive integer');
    }
    this.fetchImpl = config.fetch ?? fetch;
    this.websocketFactory = config.websocketFactory ?? defaultWebSocketFactory;
  }

  async send(input: SendInput): Promise<SentRef> {
    this.assertInbox(input.inboxId);
    const body = await this.request(`/inboxes/${encodeURIComponent(input.inboxId)}/messages/send`, {
      method: 'POST',
      body: JSON.stringify({
        to: Array.isArray(input.to) ? input.to : [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        headers: messageHeaders(input.headers, input.tradeId),
      }),
    });
    return this.sentRef(body, input.inboxId);
  }

  async reply(input: ReplyInput): Promise<SentRef> {
    this.assertRef(input.messageRef);
    const body = await this.request(
      `/inboxes/${encodeURIComponent(input.messageRef.inboxId)}/messages/${encodeURIComponent(input.messageRef.messageId)}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({
          text: input.text,
          ...(input.html ? { html: input.html } : {}),
          headers: messageHeaders(input.headers, input.tradeId),
        }),
      },
    );
    return this.sentRef(body, input.messageRef.inboxId);
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage> {
    this.assertRef(ref);
    const source = asRecord(await this.request(
      `/inboxes/${encodeURIComponent(ref.inboxId)}/messages/${encodeURIComponent(ref.messageId)}`,
      {},
      this.maxMessageBytes + MAX_JSON_OVERHEAD_BYTES,
    ));
    const size = getNumber(source, 'size', 'sizeBytes', 'size_bytes');
    if (size !== undefined && size > this.maxMessageBytes) {
      throw new Error(`AgentMail message exceeds configured size limit (${this.maxMessageBytes} bytes)`);
    }

    const from = getAddress(source.from);
    if (!from) throw new Error('AgentMail message response is missing sender');
    return {
      ref,
      ...(getString(source, 'threadId', 'thread_id')
        ? { threadId: getString(source, 'threadId', 'thread_id') }
        : {}),
      from,
      to: strings(source.to),
      ...(strings(source.cc).length > 0 ? { cc: strings(source.cc) } : {}),
      ...(getString(source, 'subject') ? { subject: getString(source, 'subject') } : {}),
      ...(getString(source, 'text') ? { text: getString(source, 'text') } : {}),
      ...(getString(source, 'html') ? { html: getString(source, 'html') } : {}),
      ...(getString(source, 'timestamp', 'receivedAt', 'received_at', 'createdAt', 'created_at')
        ? { receivedAt: getString(source, 'timestamp', 'receivedAt', 'received_at', 'createdAt', 'created_at') }
        : {}),
      ...(size === undefined ? {} : { size }),
      headers: normalizeHeaders(source.headers),
      attachments: attachments(source.attachments),
    };
  }

  async watch(input: WatchInput, emit: (event: InboundEvent) => Promise<void>): Promise<WatchHandle> {
    if (input.inboxIds.length === 0) throw new Error('at least one inboxId is required');
    for (const inboxId of input.inboxIds) this.assertInbox(inboxId);

    const url = new URL(this.websocketUrl);
    url.searchParams.set('api_key', this.apiKey);
    const socket = this.websocketFactory(url.toString());
    let intentionalClose = false;
    let settled = false;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    let delivery = Promise.resolve();

    const settleResolve = (): void => {
      if (settled) return;
      settled = true;
      resolveDone();
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectDone(error);
    };

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        type: 'subscribe',
        inboxIds: input.inboxIds,
        eventTypes: input.eventTypes ?? ['message.received'],
      }));
    });
    socket.addEventListener('message', (event) => {
      delivery = delivery.then(async () => {
        const parsed = parseAgentMailEvent(JSON.parse(eventText(event)) as unknown);
        if (parsed) await emit(parsed);
      }).catch((error: unknown) => {
        settleReject(error instanceof Error ? error : new Error(String(error)));
        socket.close(1011, 'event handling failed');
      });
    });
    socket.addEventListener('error', () => {
      if (!intentionalClose) {
        settleReject(new Error('AgentMail WebSocket error'));
        socket.close(1011, 'websocket error');
      }
    });
    socket.addEventListener('close', (event) => {
      void delivery.finally(() => {
        if (intentionalClose || event.code === 1000) settleResolve();
        else settleReject(new Error(`AgentMail WebSocket closed (${event.code ?? 'unknown'})`));
      });
    });

    const handle: WatchHandle = {
      done,
      close: async () => {
        intentionalClose = true;
        socket.close(1000, 'closed by client');
        await done.catch(() => undefined);
      },
    };
    this.watchers.add(handle);
    void done.finally(() => this.watchers.delete(handle)).catch(() => undefined);
    return handle;
  }

  async health(): Promise<ContactHealth> {
    try {
      await this.request(`/inboxes/${encodeURIComponent(this.inboxId)}`);
      return { ok: true, provider: 'agentmail' };
    } catch (error) {
      return {
        ok: false,
        provider: 'agentmail',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.watchers].map((watcher) => watcher.close()));
  }

  private async request(
    path: string,
    init: RequestInit = {},
    maxResponseBytes = DEFAULT_API_RESPONSE_BYTES,
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`AgentMail API request failed (${response.status})`);
    }
    if (response.status === 204) return {};
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      throw new Error(`AgentMail API response exceeds configured limit (${maxResponseBytes} bytes)`);
    }
    if (!response.body) return {};

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) {
          await reader.cancel();
          throw new Error(`AgentMail API response exceeds configured limit (${maxResponseBytes} bytes)`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  private sentRef(value: unknown, inboxId: string): SentRef {
    const source = asRecord(value);
    const messageId = getString(source, 'messageId', 'message_id', 'id');
    if (!messageId) throw new Error('AgentMail send response is missing message id');
    return {
      ref: { provider: 'agentmail', inboxId, messageId },
      ...(getString(source, 'threadId', 'thread_id')
        ? { threadId: getString(source, 'threadId', 'thread_id') }
        : {}),
    };
  }

  private assertInbox(inboxId: string): void {
    if (inboxId !== this.inboxId) throw new Error('AgentMail adapter is scoped to a different inbox');
  }

  private assertRef(ref: MessageRef): void {
    if (ref.provider !== 'agentmail') throw new Error('message provider must be agentmail');
    this.assertInbox(ref.inboxId);
  }
}

export function createAgentMailAdapter(config: AgentMailConfig): AgentMailAdapter {
  return new AgentMailAdapter(config);
}
