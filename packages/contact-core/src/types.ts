export interface ContactRef {
  type: string;
  uri: string;
  profile?: string;
  capabilities?: string[];
  priority?: number;
}

export interface EmailContactRef extends ContactRef {
  type: 'email';
  address: string;
}

export interface MessageRef {
  provider: string;
  inboxId: string;
  messageId: string;
}

export interface InboundEvent {
  provider: string;
  eventId: string;
  inboxId: string;
  messageRef: MessageRef;
  threadId?: string;
  from: string;
  subject?: string;
  tradeId?: string;
  receivedAt: string;
  size?: number;
  trust: 'untrusted';
}

export interface WakeMessageRef {
  provider: string;
  inbox_id: string;
  message_id: string;
}

export interface WakeTask {
  version: 'agent-trade-wake-task/0.1';
  type: 'contact.message.received';
  task_id: string;
  created_at: string;
  channel: 'email';
  provider: string;
  event_id: string;
  inbox_id: string;
  message_ref: WakeMessageRef;
  thread_id?: string;
  from: string;
  subject?: string;
  trade_id?: string;
  received_at: string;
  size?: number;
  trust: 'untrusted';
  next_actions: Array<'contact_message_get' | 'trade_get_status'>;
}

export interface AttachmentRef {
  attachmentId: string;
  filename?: string;
  contentType?: string;
  size?: number;
}

export interface StoredMessage {
  ref: MessageRef;
  threadId?: string;
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  receivedAt?: string;
  size?: number;
  headers: Record<string, string>;
  attachments: AttachmentRef[];
}

export interface SendInput {
  inboxId: string;
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  tradeId?: string;
  headers?: Record<string, string>;
}

export interface ReplyInput {
  messageRef: MessageRef;
  text: string;
  html?: string;
  tradeId?: string;
  headers?: Record<string, string>;
}

export interface SentRef {
  ref: MessageRef;
  threadId?: string;
}

export interface WatchInput {
  inboxIds: string[];
  eventTypes?: Array<'message.received'>;
}

export interface WatchHandle {
  done: Promise<void>;
  close(): Promise<void>;
}

export interface ContactHealth {
  ok: boolean;
  provider: string;
  detail?: string;
}

export interface ContactAdapter {
  send(input: SendInput): Promise<SentRef>;
  reply(input: ReplyInput): Promise<SentRef>;
  getMessage(ref: MessageRef): Promise<StoredMessage>;
  watch(input: WatchInput, emit: (event: InboundEvent) => Promise<void>): Promise<WatchHandle>;
  health(): Promise<ContactHealth>;
  close(): Promise<void>;
}
