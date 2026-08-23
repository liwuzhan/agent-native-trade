import type { ContactRef, EmailContactRef } from './types.js';

const EMAIL_PROFILE = 'agent-trade-email-v1';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function priorityOf(ref: ContactRef): number {
  return Number.isFinite(ref.priority) ? (ref.priority as number) : 0;
}

export function parseEmailContact(ref: ContactRef): EmailContactRef {
  if (ref.type !== 'email') {
    throw new Error(`unsupported contact type: ${ref.type}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(ref.uri);
  } catch {
    throw new Error('email contact uri must be a valid mailto URI');
  }

  if (parsed.protocol !== 'mailto:' || parsed.search || parsed.hash) {
    throw new Error('email contact uri must be a plain mailto address');
  }

  const address = decodeURIComponent(parsed.pathname);
  if (!EMAIL_RE.test(address) || address.includes(',')) {
    throw new Error('email contact uri must contain exactly one address');
  }

  const capabilities = [...new Set(ref.capabilities ?? [])];
  return {
    type: 'email',
    uri: `mailto:${address}`,
    address,
    profile: ref.profile ?? EMAIL_PROFILE,
    capabilities,
    priority: priorityOf(ref),
  };
}

export function resolveEmailContacts(refs: ContactRef[]): EmailContactRef[] {
  return refs
    .map((ref, index) => ({ ref, index }))
    .filter(({ ref }) => ref.type === 'email')
    .map(({ ref, index }) => ({ parsed: parseEmailContact(ref), index }))
    .sort((a, b) => priorityOf(b.parsed) - priorityOf(a.parsed) || a.index - b.index)
    .map(({ parsed }) => parsed);
}
