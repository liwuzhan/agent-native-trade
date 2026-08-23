import { createHash } from 'node:crypto';
import type { InboundEvent, WakeTask } from './types.js';

export function wakeTaskId(event: InboundEvent): string {
  const key = [event.provider, event.inboxId, event.messageRef.messageId].join('\0');
  return `wake_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

export function createWakeTask(event: InboundEvent, now = new Date()): WakeTask {
  const nextActions: WakeTask['next_actions'] = ['contact_message_get'];
  if (event.tradeId) nextActions.push('trade_get_status');

  return {
    version: 'agent-trade-wake-task/0.1',
    type: 'contact.message.received',
    task_id: wakeTaskId(event),
    created_at: now.toISOString(),
    channel: 'email',
    provider: event.provider,
    event_id: event.eventId,
    inbox_id: event.inboxId,
    message_ref: {
      provider: event.messageRef.provider,
      inbox_id: event.messageRef.inboxId,
      message_id: event.messageRef.messageId,
    },
    ...(event.threadId ? { thread_id: event.threadId } : {}),
    from: event.from,
    ...(event.subject ? { subject: event.subject } : {}),
    ...(event.tradeId ? { trade_id: event.tradeId } : {}),
    received_at: event.receivedAt,
    ...(event.size === undefined ? {} : { size: event.size }),
    trust: 'untrusted',
    next_actions: nextActions,
  };
}
