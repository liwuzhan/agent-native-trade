export { FileWakeQueue } from './queue.js';
export type { EnqueueResult } from './queue.js';
export { parseEmailContact, resolveEmailContacts } from './refs.js';
export type {
  AttachmentRef,
  ContactAdapter,
  ContactHealth,
  ContactRef,
  EmailContactRef,
  InboundEvent,
  MessageRef,
  ReplyInput,
  SendInput,
  SentRef,
  StoredMessage,
  WakeMessageRef,
  WakeTask,
  WatchHandle,
  WatchInput,
} from './types.js';
export { createWakeTask, wakeTaskId } from './wake.js';
