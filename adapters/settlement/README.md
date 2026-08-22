# @agent-trade/settlement (module M6)

Settlement adapters that push a trade from `AGREED` to `FULFILLING`
(`COMPLETED` belongs to logistics/sign-off events and is out of scope).

```ts
export interface SettlementContext { store: Store; agentId: string; secretKey: string }
export interface SettlementAdapter {
  method: 'test-voucher' | 'manual-settlement';
  request(deal: SignedFile, ctx: SettlementContext): Promise<SignedFile>; // buyer → PAYMENT_REQUESTED
  confirm(deal: SignedFile, ctx: SettlementContext): Promise<SignedFile>; // seller/executor → PAYMENT_CONFIRMED
}
export function createTestVoucherAdapter(opts?: { issuer?: string }): SettlementAdapter;
export function createManualSettlementAdapter(opts: { taskStore: HumanTaskStore }): SettlementAdapter;
export function markFulfilling(deal: SignedFile, ctx: SettlementContext, opts?): Promise<SignedFile>;
```

## Rules implemented

- Every produced `TRADE_EVENT` is signed and run through `store.applyEvent`,
  which verifies (`verifyFile === 'valid'`, throws otherwise) before the state
  machine transition — a returned event is valid and applied by construction.
- State chain: `AGREED → PAYMENT_PENDING → PAYMENT_CONFIRMED → FULFILLING`
  (state machine enforced by `@agent-trade/local-store`).
- `evidence` holds only `method` / `executor_ref` / credential id
  (`voucher_id` or `task_id`). `ctx.secretKey` is used to sign in memory and is
  never persisted; no public field carries secret material.

### test-voucher

- Issues a fully fictional `TEST-VOUCHER-<uuid v7>` whose face value is the
  exact decimal fixed-point string of `deal.body.settlement.amount`
  (`"3200.0"` ≠ `"3200.00"`, character exact). Missing/malformed amounts are
  rejected at `request`.
- The voucher registry is in-memory and scoped to one adapter instance
  (test/scratch tooling; the card excludes real payment infrastructure).
- Redemption voids the code: redeeming the same code twice is rejected;
  `confirm` also re-checks the deal amount against the recorded face value, so
  a divergent deal is refused.

### manual-settlement

- `request` creates a `PAY` task through the injected `HumanTaskStore` and
  emits `PAYMENT_REQUESTED` referencing `task_id`.
- After the human completes the task (`taskStore.complete`), `confirm` verifies
  the task is `DONE` and the model (seller credentials in `ctx`) signs
  `PAYMENT_CONFIRMED`.

## HumanTaskStore — structural contract with M7

M7 (`adapters/human-task`) is developed in parallel; this package never
imports its source. `HumanTaskStore` is declared here as a pure type contract
(`src/human-task.ts`, a copy of the M7 card's interface block). TypeScript
structural typing makes a runtime M7 store assignable; the caller injects the
instance via `createManualSettlementAdapter({ taskStore })`.

## Dev

```
npm install
npm test            # vitest run
npm run build       # tsc -b
npm run test:typecheck
```

Dependencies: `@agent-trade/signed-files`, `@agent-trade/local-store`
(runtime, `file:../../packages/…`); dev: `@agent-trade/identity`,
`vitest 4.1.11`, `typescript 5.9.3`, `@types/node 24.13.3`.
