/**
 * Local signing policy (module card M9): configurable guardrails applied when
 * the signing model asks to sign a deal. Load order:
 *
 *   1. an explicit `policy` option (tests / embedding),
 *   2. `<dir>/.data/policy.json` — local override next to the keyring,
 *   3. the app's shipped `policy.json` (no limits by default).
 *
 * A malformed configured value fails fast at load time so a typo surfaces at
 * startup, not mid-trade.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Policy {
  /**
   * Optional cap on deal.body.settlement.amount, as a decimal fixed-point
   * string (specification.md §4: `^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$`).
   * `null` / absent = no cap. Barter deals (no `amount`) are never capped.
   */
  max_amount_per_deal?: string | null;
}

const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/;

export function isDecimal(s: string): boolean {
  return DECIMAL_RE.test(s);
}

/** Decimal fixed-point string → integer units of 1e-8 (exact, no float). */
export function decimalToUnits(s: string): bigint {
  const dot = s.indexOf('.');
  const int = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? '' : s.slice(dot + 1);
  return BigInt(int) * 10n ** 8n + BigInt((frac + '00000000').slice(0, 8));
}

function assertValidAmount(label: string, value: string): void {
  if (!isDecimal(value)) {
    throw new Error(`policy: ${label} ${JSON.stringify(value)} is not a decimal fixed-point string`);
  }
}

export function validatePolicy(policy: Policy): Policy {
  const cap = policy.max_amount_per_deal;
  if (cap !== undefined && cap !== null) {
    if (typeof cap !== 'string') {
      throw new Error(`policy: max_amount_per_deal must be a decimal string or null, got ${typeof cap}`);
    }
    assertValidAmount('max_amount_per_deal', cap);
  }
  return policy;
}

export function loadPolicy(dir: string, explicit?: Policy): Policy {
  if (explicit !== undefined) return validatePolicy(explicit);
  const local = join(dir, '.data', 'policy.json');
  if (existsSync(local)) {
    return validatePolicy(JSON.parse(readFileSync(local, 'utf8')) as Policy);
  }
  const shipped = new URL('../policy.json', import.meta.url);
  return validatePolicy(JSON.parse(readFileSync(shipped, 'utf8')) as Policy);
}

/**
 * Enforce `max_amount_per_deal` against a deal body's `settlement.amount`.
 * Returns an error message when the deal is over budget, `null` when allowed.
 * Deals without a settlement amount (barter) are not capped.
 */
export function checkAmountPolicy(policy: Policy, amount: string | undefined): string | null {
  const cap = policy.max_amount_per_deal;
  if (cap === undefined || cap === null || amount === undefined) return null;
  // Both are schema-validated decimal strings at this point; compare exactly.
  if (decimalToUnits(amount) > decimalToUnits(cap)) {
    return `policy rejected: amount ${amount} exceeds max_amount_per_deal ${cap}`;
  }
  return null;
}
