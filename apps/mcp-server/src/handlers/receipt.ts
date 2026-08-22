/**
 * TRADE_RECEIPT tools: trade_create_receipt signs a receipt body with the
 * signer's local key and persists it (putObject verifies the full envelope
 * before writing); trade_verify_receipt runs the four-step verification.
 */

import { addSignature, buildObject, objectId, verifyFile } from '@agent-trade/signed-files';

import type { TradeApp } from '../app.js';
import { validateBody } from '../schema.js';
import { isPlainObject, resolveEnvelope } from '../shared.js';
import type { ToolSummary } from '../shared.js';

/** trade_create_receipt — build + sign + persist a TRADE_RECEIPT. */
export async function createReceipt(args: Record<string, unknown>, app: TradeApp): Promise<ToolSummary> {
  if (!isPlainObject(args.body)) {
    throw new Error(`create_receipt: "body" must be a JSON object (the TRADE_RECEIPT body), got ${typeof args.body}`);
  }
  const body = (await validateBody('TRADE_RECEIPT', args.body)) as { receipt_id?: unknown; trade_id?: unknown };
  const signer = typeof args.signer === 'string' && args.signer.length > 0 ? (args.signer as string) : app.agentId;
  const secretKey = app.secretKeyOf(signer);
  if (secretKey === undefined) {
    throw new Error(`create_receipt: no private key for "${signer}" under .data/keys/`);
  }

  const receipt = addSignature(buildObject('TRADE_RECEIPT', body), signer, secretKey);
  // putObject verifies the full envelope (schema + signatures) and persists;
  // throws unless 'valid', so an invalid receipt is never stored.
  const id = app.store.putObject(receipt);
  return { object_id: id, receipt_id: body.receipt_id, trade_id: body.trade_id, signer, status: 'created' };
}

/** trade_verify_receipt — four-step verification; envelope or stored object_id. */
export function verifyReceipt(args: Record<string, unknown>, app: TradeApp): ToolSummary {
  const file = resolveEnvelope(app, args.receipt, args.object_id, 'verify_receipt');
  if (file.object_type !== 'TRADE_RECEIPT') {
    throw new Error(`verify_receipt: expected a TRADE_RECEIPT object, got ${JSON.stringify(file.object_type)}`);
  }
  return { object_id: objectId(file), object_type: 'TRADE_RECEIPT', result: verifyFile(file, app.resolveKey) };
}
