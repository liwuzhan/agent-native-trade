/**
 * createTradeServer — build an {@linkcode McpServer} (SDK V2) exposing the ten
 * trade tools over one shared {@linkcode TradeApp}. Tool input schemas are
 * JSON Schema compiled by the SDK's bundled validator via `fromJsonSchema`.
 *
 * Signing surface (red line): `trade_sign_deal` is the ONLY tool that
 * produces a signature, and its input schema admits exactly
 * `deal` + `expected_body_hash` (+ optional `signer` to pick a local key) —
 * there is no tool accepting raw bytes/payloads to sign.
 */

import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';

import type { TradeApp } from './app.js';
import { compileDeal, signDeal, verifyDeal } from './handlers/deal.js';
import { getStatus, recordEvent } from './handlers/event.js';
import { identityCreate } from './handlers/identity.js';
import { createReceipt, verifyReceipt } from './handlers/receipt.js';
import { settlementConfirm, settlementRequest } from './handlers/settlement.js';
import { ok } from './shared.js';
import type { ToolSummary } from './shared.js';

type Handler = (args: Record<string, unknown>, app: TradeApp) => ToolSummary | Promise<ToolSummary>;

function registerTool(
  server: McpServer,
  app: TradeApp,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: Handler,
  annotations?: { readOnlyHint?: boolean },
): void {
  server.registerTool(
    name,
    {
      title: name,
      description,
      inputSchema: fromJsonSchema<Record<string, unknown>>(inputSchema),
      annotations,
    },
    async (args) => {
      const summary = await handler(args, app);
      return ok(summary);
    },
  );
}

/**
 * Build the MCP server bound to `app`. Safe to call multiple times (one
 * McpServer per stdio connection, or one per test) — every handler closes
 * over the exact `app` passed here.
 */
export function createTradeServer(app: TradeApp): McpServer {
  const server = new McpServer({ name: 'agent-trade', version: '0.2.0' }, { capabilities: { tools: {} } });

  registerTool(
    server,
    app,
    'trade_identity_create',
    'Generate a fresh local Ed25519 identity for this machine and persist its private key under .data/keys/ (0600). Returns agentId + public key; never the private key.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentId: { type: 'string', description: 'Optional agent id; defaults to a generated agent_<hex> id. Must not already exist locally.' },
      },
    },
    identityCreate,
    { readOnlyHint: false },
  );

  registerTool(
    server,
    app,
    'trade_compile_deal',
    'Draft a DEAL: schema-validates the body and returns its object_id + body_hash. Compilation happens once per trade; the counterparty reviews and signs the same file. To sign, pass the reconstructed envelope {protocol:"agent-trade/0.2", object_type:"DEAL", body, body_hash, signatures:[]} to trade_sign_deal with expected_body_hash=<body_hash>.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['body'],
      properties: {
        body: {
          type: 'object',
          description:
            'DEAL body: {trade_id (uuid v7), buyer, seller, subject:{listing_ref, description, quantity, acceptance_conditions[]}, settlement:{asset, amount (decimal string), method, ...}, fulfillment:{deadline (RFC3339), destination_ref, carrier_ref}}',
        },
      },
    },
    compileDeal,
    { readOnlyHint: false },
  );

  registerTool(
    server,
    app,
    'trade_sign_deal',
    "SIGNING RED LINE: signs a DEAL with a local private key from .data/keys/. Accepts ONLY the deal envelope + expected_body_hash: the body is schema-validated, body_hash is recomputed and must equal expected_body_hash, otherwise signing is refused. The signing decision is the calling model's — there is NO human confirmation step. Optional local policy (policy.json max_amount_per_deal) may refuse over-budget deals. The signed deal is persisted; returns object_id.",
    {
      type: 'object',
      additionalProperties: false,
      required: ['deal', 'expected_body_hash'],
      properties: {
        deal: {
          type: 'object',
          description:
            'The DEAL envelope object: {protocol:"agent-trade/0.2", object_type:"DEAL", body, body_hash, signatures:[]} as returned by trade_compile_deal (signatures may be empty for a draft).',
        },
        expected_body_hash: {
          type: 'string',
          pattern: '^sha256:[0-9a-f]{64}$',
          description: 'The body_hash returned by trade_compile_deal for this body. Signing is refused unless the recomputed hash matches exactly.',
        },
        signer: {
          type: 'string',
          description: "Optional agent id whose local .data/keys/ private key signs; defaults to the server's agent. Callers never supply keys.",
        },
      },
    },
    signDeal,
    { readOnlyHint: false },
  );

  registerTool(
    server,
    app,
    'trade_verify_deal',
    'Four-step verification of a DEAL (body_hash recompute, object_id, schema, strict Ed25519 signatures) against the local trust ring. Accepts either the deal envelope object or the object_id of a stored deal. Returns result: "valid" or fail:* reason.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        deal: { type: 'object', description: 'The signed DEAL envelope to verify.' },
        object_id: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$', description: 'object_id of a deal already stored by trade_sign_deal.' },
      },
    },
    verifyDeal,
    { readOnlyHint: true },
  );

  registerTool(
    server,
    app,
    'trade_record_event',
    "Sign (with the actor's local key) and apply a TRADE_EVENT to the trade state machine: DEAL_SIGNED (initial, →AGREED), PAYMENT_REQUESTED, PAYMENT_CONFIRMED, ESCROWED, FULFILLING, SHIPPED, DELIVERED, COMPLETED (only after DELIVERED), DISPUTED, RESOLVED, CANCELLED. Illegal transitions are rejected. Returns the new state.",
    {
      type: 'object',
      additionalProperties: false,
      required: ['trade_id', 'event_type'],
      properties: {
        trade_id: { type: 'string', description: 'The trade_id from the deal.' },
        event_type: {
          type: 'string',
          enum: ['DEAL_SIGNED', 'PAYMENT_REQUESTED', 'PAYMENT_CONFIRMED', 'ESCROWED', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'DISPUTED', 'RESOLVED', 'CANCELLED'],
        },
        actor: { type: 'string', description: "Optional agent id signing the event (local key required); defaults to the server's agent." },
        evidence: { type: 'object', description: 'Optional free-form evidence object.' },
        message: { type: 'string', description: 'Optional human-readable message.' },
      },
    },
    recordEvent,
    { readOnlyHint: false },
  );

  registerTool(
    server,
    app,
    'trade_get_status',
    'Current state of a trade (AGREED → PAYMENT_PENDING → PAYMENT_CONFIRMED → FULFILLING → SHIPPED → DELIVERED → COMPLETED, plus DISPUTED/RESOLVED/CANCELLED). object_id in the response is the trade_id (the queried object).',
    {
      type: 'object',
      additionalProperties: false,
      required: ['trade_id'],
      properties: {
        trade_id: { type: 'string', description: 'The trade_id to query.' },
      },
    },
    getStatus,
    { readOnlyHint: true },
  );

  registerTool(
    server,
    app,
    'trade_create_receipt',
    'Build, sign and persist a TRADE_RECEIPT (post-trade evidence: result, rating, direction, contract_hash = deal object_id, optional metrics/transaction_summary/evidence). Returns the receipt object_id.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['body'],
      properties: {
        body: {
          type: 'object',
          description:
            'TRADE_RECEIPT body: {receipt_id, trade_id, contract_hash ("sha256:" hex), subject (counterparty agent), direction ("buyer_to_seller"|"seller_to_buyer"|"third_party"), result ("COMPLETED"|"DISPUTED"|"RESOLVED"|"CANCELLED"), rating ("POSITIVE"|"NEUTRAL"|"NEGATIVE"|"FACT_ONLY"), optional comment/metrics/transaction_summary/evidence}.',
        },
        signer: { type: 'string', description: "Optional agent id signing the receipt (local key required); defaults to the server's agent." },
      },
    },
    createReceipt,
    { readOnlyHint: false },
  );

  registerTool(
    server,
    app,
    'trade_verify_receipt',
    'Four-step verification of a TRADE_RECEIPT against the local trust ring. Accepts either the receipt envelope or the object_id of a stored receipt. Returns result: "valid" or fail:* reason.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        receipt: { type: 'object', description: 'The signed TRADE_RECEIPT envelope to verify.' },
        object_id: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$', description: 'object_id of a receipt already stored by trade_create_receipt.' },
      },
    },
    verifyReceipt,
    { readOnlyHint: true },
  );

  registerTool(
    server,
    app,
    'settlement_request',
    'Buyer requests payment: emits PAYMENT_REQUESTED (AGREED → PAYMENT_PENDING) via the settlement adapter. The deal must be valid and the DEAL_SIGNED event recorded first. method "test-voucher" (default, fictional in-memory voucher) or "manual-settlement" (creates a human PAY task). Accepts the deal envelope or its object_id.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        deal: { type: 'object', description: 'The signed DEAL envelope (from trade_sign_deal).' },
        object_id: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$', description: 'object_id of the stored signed deal.' },
        method: { type: 'string', enum: ['test-voucher', 'manual-settlement'], description: 'Settlement method; defaults to test-voucher.' },
        actor: { type: 'string', description: "Optional agent id requesting payment (local key required); defaults to the server's agent." },
      },
    },
    settlementRequest,
    { readOnlyHint: false },
  );

  registerTool(
    server,
    app,
    'settlement_confirm',
    'Seller/executor confirms payment: emits PAYMENT_CONFIRMED (→ PAYMENT_CONFIRMED) via the settlement adapter. test-voucher redeems the voucher issued by settlement_request; manual-settlement requires the human PAY task to be DONE first. Accepts the deal envelope or its object_id.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        deal: { type: 'object', description: 'The signed DEAL envelope (from trade_sign_deal).' },
        object_id: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$', description: 'object_id of the stored signed deal.' },
        method: { type: 'string', enum: ['test-voucher', 'manual-settlement'], description: 'Settlement method; must match the one used in settlement_request. Defaults to test-voucher.' },
        actor: { type: 'string', description: "Optional agent id confirming payment (local key required); defaults to the server's agent." },
      },
    },
    settlementConfirm,
    { readOnlyHint: false },
  );

  return server;
}

/** The set of tool names this server exposes (used by tests + docs). */
export const TOOL_NAMES = [
  'trade_identity_create',
  'trade_compile_deal',
  'trade_sign_deal',
  'trade_verify_deal',
  'trade_record_event',
  'trade_get_status',
  'trade_create_receipt',
  'trade_verify_receipt',
  'settlement_request',
  'settlement_confirm',
] as const;
