/**
 * Trade state machine for agent-trade/0.2 (module card M3, specification.md §4).
 *
 * Legal chain: AGREED → PAYMENT_PENDING → PAYMENT_CONFIRMED → FULFILLING →
 * SHIPPED → DELIVERED → COMPLETED, with DISPUTED / RESOLVED / CANCELLED
 * branches. Payment events never skip a state, COMPLETED only follows
 * DELIVERED, and COMPLETED / CANCELLED are terminal.
 */

export type TradeState =
  | 'AGREED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_CONFIRMED'
  | 'FULFILLING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'DISPUTED'
  | 'RESOLVED'
  | 'CANCELLED';

/** TRADE_EVENT body.event_type values (schema enum). */
export type EventType =
  | 'DEAL_SIGNED'
  | 'PAYMENT_REQUESTED'
  | 'PAYMENT_CONFIRMED'
  | 'ESCROWED'
  | 'FULFILLING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'DISPUTED'
  | 'RESOLVED'
  | 'CANCELLED';

/** Terminal states: no event may transition out of them. */
export const TERMINAL_STATES: ReadonlySet<TradeState> = new Set<TradeState>(['COMPLETED', 'CANCELLED']);

export interface TransitionResult {
  /** the state the trade is in after this event */
  state: TradeState;
  /**
   * state to restore on RESOLVED; non-null only while the trade is DISPUTED,
   * null otherwise.
   */
  preDispute: TradeState | null;
}

function requireFrom(current: TradeState | undefined, expected: TradeState, eventType: EventType): asserts current is TradeState {
  if (current !== expected) {
    throw new Error(
      `invalid transition: ${eventType} requires state ${expected}, got ${current ?? 'none'}`,
    );
  }
}

function requireActiveTrade(current: TradeState | undefined, eventType: EventType): asserts current is TradeState {
  if (current === undefined) {
    throw new Error(`invalid transition: ${eventType} requires an existing trade (no DEAL_SIGNED yet)`);
  }
}

/**
 * Apply one event to the state machine. Throws on any transition outside the
 * module-card table; never mutates anything itself (the caller persists only
 * after this returns).
 */
export function transition(
  current: TradeState | undefined,
  preDispute: TradeState | null,
  eventType: EventType,
): TransitionResult {
  if (current !== undefined && TERMINAL_STATES.has(current)) {
    throw new Error(`invalid transition: ${eventType} from terminal state ${current}`);
  }

  switch (eventType) {
    case 'DEAL_SIGNED':
      // only initial: the very first event of a trade
      if (current !== undefined) {
        throw new Error(`invalid transition: DEAL_SIGNED only allowed as the initial event, trade is already in ${current}`);
      }
      return { state: 'AGREED', preDispute: null };

    case 'PAYMENT_REQUESTED':
      requireFrom(current, 'AGREED', eventType);
      return { state: 'PAYMENT_PENDING', preDispute: null };

    case 'PAYMENT_CONFIRMED':
    case 'ESCROWED':
      requireFrom(current, 'PAYMENT_PENDING', eventType);
      return { state: 'PAYMENT_CONFIRMED', preDispute: null };

    case 'FULFILLING':
      requireFrom(current, 'PAYMENT_CONFIRMED', eventType);
      return { state: 'FULFILLING', preDispute: null };

    case 'SHIPPED':
      requireFrom(current, 'FULFILLING', eventType);
      return { state: 'SHIPPED', preDispute: null };

    case 'DELIVERED':
      requireFrom(current, 'SHIPPED', eventType);
      return { state: 'DELIVERED', preDispute: null };

    case 'COMPLETED':
      // only from DELIVERED (specification.md §4: 付款事件不越级)
      requireFrom(current, 'DELIVERED', eventType);
      return { state: 'COMPLETED', preDispute: null };

    case 'DISPUTED':
      // from any non-terminal state; remember the pre-dispute state once
      requireActiveTrade(current, eventType);
      return { state: 'DISPUTED', preDispute: preDispute ?? current };

    case 'RESOLVED':
      // only from DISPUTED; restores the pre-dispute state
      requireFrom(current, 'DISPUTED', eventType);
      if (preDispute === null) {
        throw new Error('invalid transition: RESOLVED without a recorded pre-dispute state (corrupt index)');
      }
      return { state: preDispute, preDispute: null };

    case 'CANCELLED':
      // from any non-terminal state; terminal
      requireActiveTrade(current, eventType);
      return { state: 'CANCELLED', preDispute: null };
  }
}
