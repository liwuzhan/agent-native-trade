# @agent-trade/contact-agentmail

AgentMail implementation of `ContactAdapter` using the Node 24 built-in `fetch` and
`WebSocket` clients. It has no third-party runtime dependency.

Implemented operations:

- REST send, reply, get-message and health check;
- WebSocket `message.received` subscription;
- compatibility parsing for the live event envelope and documented SDK-style names;
- `X-Trade-Id` correlation;
- inbox scope checks, metadata-only inbound events and configurable message size gating.

The adapter manages one configured inbox. It never includes the API response body in an error
and does not log the WebSocket URL, because AgentMail supports API-key authentication through a
query parameter for raw WebSocket clients.
