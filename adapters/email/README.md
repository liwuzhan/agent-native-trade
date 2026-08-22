# @agent-trade/email — M5 email adapter

SMTP send / IMAP poll / MIME parse adapter. The first communication channel
between agents: messages carry a `X-Trade-Id` header that correlates them to a
trade; polling is idempotent via a persisted Message-ID store; oversized mail
and attachments are rejected before they are fully materialized.

Implements `docs/module-cards/M5-email.md`.

## Public surface

```ts
createMailAdapter(config: MailConfig): MailAdapter
// MailAdapter: { send(msg: OutboundMsg): Promise<void>, poll(): Promise<InboundMsg[]>, close(): Promise<void> }
```

`MailConfig`: `{ smtpUrl, imapUrl, inboxDir, seenStorePath, maxMailBytes?, maxAttachmentBytes? }`
— defaults `maxMailBytes` 10 MiB, `maxAttachmentBytes` 2 MiB.

URLs: `smtp://user:pass@host:port` / `smtps://…` / `imap://…` / `imaps://…`
(no port → 587/465 for SMTP, 143/993 for IMAP).

## Hard rules

- **send** always attaches `X-Trade-Id`; `OutboundMsg.inReplyTo?` adds the
  `In-Reply-To` header. The SMTP envelope sender is derived from the SMTP URL
  user (`user@host`), since the card's `OutboundMsg` has no `from` field.
- **size gating precedes parsing**: `poll()` first fetches only
  `uid`/`size`/`envelope` (RFC822.SIZE) and skips messages over
  `maxMailBytes` **without downloading the body**.
- attachments over `maxAttachmentBytes` are refused and never written; the
  rest of the message is still delivered.
- attachments are only written under `inboxDir`; filenames are sanitized
  (traversal segments, absolute paths, Windows separators/drives stripped) and
  colliding names get `-1`/`-2` suffixes.
- idempotency: processed Message-IDs are persisted to `seenStorePath`
  (atomic tmp-file + rename); duplicate deliveries are absorbed.

## Tests

```bash
npm test                  # unit tests (in-memory mailbox fixture, no server)
GREENMAIL=1 npm run test:integration   # needs the GreenMail container (below)
npm run build             # tsc -b
```

Unit tests cover parsing, `X-Trade-Id` correlation, idempotency (in-instance
and across restarts), mail/attachment size rejection (asserting the body is
never downloaded) and path-traversal sanitization.

GreenMail integration (gated by `GREENMAIL=1`, skipped otherwise):

```bash
docker compose -f docker-compose.greenmail.yml up -d
GREENMAIL=1 npx vitest run
```

Integration coverage: real send→poll round-trip, `X-Trade-Id` present on the
wire, duplicate-delivery idempotency, oversized mail rejected with only
SIZE/HEADER fetches recorded (via the optional `fetchTrace` hook), oversized
attachments refused.

## Internal seams (not part of the card contract)

- `createMailAdapter(config, deps?)` — optional second argument to inject an
  in-memory `MailboxSource`, a recording `SendTransport`, a `SeenStore` or a
  `fetchTrace` observer for tests. One-argument calls behave exactly per the
  card.
- `EmailAdapter` class is exported from `src/adapter.ts` (not from the public
  `src/index.ts`).

## Proposed FUTURE.md entries (module M5)

The card's boundary says trade-offs go to the root `FUTURE.md`; that file is
outside this adapter's working directory, so the entries are listed here for
the maintainer to register:

- Real mailbox hygiene: mark messages `\Seen`/move to `Processed` after poll,
  so INBOX growth is bounded (currently messages are kept).
- Message-ID fallback for headerless mail is synthetic (`imap-uid-<uid>@localhost`)
  and scoped to one mailbox (uidValidity not tracked).
- Colliding attachment names are renamed (`-1`, `-2`, …) instead of rejected.
- `X-Trade-Id`-less inbound mail is returned with `tradeId: ''` — no policy
  decision about whether it should be dropped or quarantined.
- Reconnect/retry policy for flaky SMTP/IMAP connections (currently fail-fast
  with one fresh connection per poll).
