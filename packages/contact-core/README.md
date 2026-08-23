# @agent-trade/contact-core

Provider-neutral contact primitives for agent-trade:

- portable `contact_refs` parsing (`mailto:` first);
- `ContactAdapter` and metadata-only `InboundEvent` types;
- compact `agent-trade-wake-task/0.1` tasks;
- a private, durable file queue with deterministic message deduplication.

`WakeTask` deliberately excludes message body, HTML and attachment contents. `FileWakeQueue`
creates directories with mode `0700`, files with mode `0600`, and acknowledges by moving tasks
to `done/` instead of deleting them.
