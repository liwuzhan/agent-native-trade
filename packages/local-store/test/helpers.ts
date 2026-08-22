import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { addSignature, buildObject } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';
import { generateIdentity } from '@agent-trade/identity';
import type { Identity } from '@agent-trade/identity';

/**
 * Test fixtures. Vector identities/files come straight from the authoritative
 * protocol test-vectors (specification.md: "权威源：protocol/test-vectors/").
 * Test-only; runtime code never reads repo-relative paths.
 */

export interface VectorIdentity {
  public_key: string;
  seed: string;
}

export interface VectorCase {
  name: string;
  object_type: SignedFile['object_type'];
  file: SignedFile;
  object_id?: string;
  expect: string;
  tamper?: string;
}

export interface Vectors {
  identities: Record<string, VectorIdentity>;
  cases: VectorCase[];
}

export function loadVectors(): Vectors {
  const url = new URL('../../../protocol/test-vectors/vectors.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Vectors;
}

export function mintIdentity(): Identity {
  return generateIdentity();
}

export interface MakeEventParams {
  tradeId: string;
  eventType: string;
  actor: string;
  secretKey: string;
  occurredAt: string;
  message?: string;
  eventId?: string;
}

/** Build a single-signed TRADE_EVENT with a schema-valid body. */
export function makeEvent(params: MakeEventParams): SignedFile {
  const body: Record<string, unknown> = {
    event_id: params.eventId ?? randomUUID(),
    trade_id: params.tradeId,
    event_type: params.eventType,
    actor: params.actor,
    occurred_at: params.occurredAt,
  };
  if (params.message !== undefined) body.message = params.message;
  return addSignature(buildObject('TRADE_EVENT', body), params.actor, params.secretKey);
}

/** RFC 3339 UTC timestamp helper: `base` + `i` seconds, uniform format. */
export function at(base: string, i = 0): string {
  return new Date(Date.parse(base) + i * 1000).toISOString();
}
