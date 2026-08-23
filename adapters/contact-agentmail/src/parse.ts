import type { InboundEvent } from '@agent-trade/contact-core';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function firstString(source: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function firstNumber(source: UnknownRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function address(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return address(value[0]);
  const source = record(value);
  return firstString(source, 'email', 'address');
}

export function normalizeHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const item = record(entry);
      const name = firstString(item, 'name', 'key');
      const headerValue = firstString(item, 'value');
      if (name && headerValue) headers[name] = headerValue;
    }
    return headers;
  }

  for (const [key, raw] of Object.entries(record(value))) {
    if (typeof raw === 'string') headers[key] = raw;
    else if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
      headers[key] = raw.join(', ');
    }
  }
  return headers;
}

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
}

export function parseAgentMailEvent(value: unknown): InboundEvent | undefined {
  const envelope = record(value);
  const envelopeType = firstString(envelope, 'type');
  const eventType = firstString(envelope, 'eventType', 'event_type')
    ?? (envelopeType === 'message_received' ? 'message.received' : undefined);

  if (eventType !== 'message.received') return undefined;
  if (envelopeType && envelopeType !== 'event' && envelopeType !== 'message_received') return undefined;

  const message = record(envelope.message ?? envelope.data);
  const messageId = firstString(message, 'messageId', 'message_id', 'id');
  const inboxId = firstString(message, 'inboxId', 'inbox_id')
    ?? firstString(envelope, 'inboxId', 'inbox_id');
  const sender = address(message.from ?? envelope.from);
  if (!messageId || !inboxId || !sender) return undefined;

  const headers = normalizeHeaders(message.headers);
  const receivedAt = firstString(message, 'timestamp', 'receivedAt', 'received_at', 'createdAt', 'created_at')
    ?? new Date().toISOString();

  return {
    provider: 'agentmail',
    eventId: firstString(envelope, 'eventId', 'event_id', 'id') ?? `message:${messageId}`,
    inboxId,
    messageRef: { provider: 'agentmail', inboxId, messageId },
    ...(firstString(message, 'threadId', 'thread_id')
      ? { threadId: firstString(message, 'threadId', 'thread_id') }
      : {}),
    from: sender,
    ...(firstString(message, 'subject') ? { subject: firstString(message, 'subject') } : {}),
    ...(headerValue(headers, 'x-trade-id') ? { tradeId: headerValue(headers, 'x-trade-id') } : {}),
    receivedAt,
    ...(firstNumber(message, 'size', 'sizeBytes', 'size_bytes') === undefined
      ? {}
      : { size: firstNumber(message, 'size', 'sizeBytes', 'size_bytes') }),
    trust: 'untrusted',
  };
}

export function asRecord(value: unknown): UnknownRecord {
  return record(value);
}

export function getString(source: UnknownRecord, ...keys: string[]): string | undefined {
  return firstString(source, ...keys);
}

export function getNumber(source: UnknownRecord, ...keys: string[]): number | undefined {
  return firstNumber(source, ...keys);
}

export function getAddress(value: unknown): string | undefined {
  return address(value);
}
