# trade-inboxd

`trade-inboxd` converts provider events into durable, metadata-only WakeTasks. It is an event
receiver, not an agent policy engine: queue-only mode is the default, and it never automatically
reads an email or starts a model.

## Quick start

```bash
npm --prefix packages/contact-core install && npm --prefix packages/contact-core run build
npm --prefix adapters/contact-agentmail install && npm --prefix adapters/contact-agentmail run build
npm --prefix apps/trade-inboxd install && npm --prefix apps/trade-inboxd run build
mkdir -p "$HOME/.agent-trade"
cp apps/trade-inboxd/examples/agentmail.json "$HOME/.agent-trade/inboxd.json"
export AGENTMAIL_API_KEY='an inbox-scoped key'
node apps/trade-inboxd/dist/cli.js doctor --config "$HOME/.agent-trade/inboxd.json"
node apps/trade-inboxd/dist/cli.js run --config "$HOME/.agent-trade/inboxd.json"
```

The config stores only the environment variable name, never the key itself. Edit `inboxId` and set
`dataDir` to `contact` before running. Relative data paths resolve from the config file, so this
layout writes to `$HOME/.agent-trade/contact`, matching the DSH preset default. Pending tasks are
under `<dataDir>/pending/`:

```bash
node apps/trade-inboxd/dist/cli.js list --config "$HOME/.agent-trade/inboxd.json"
node apps/trade-inboxd/dist/cli.js ack --config "$HOME/.agent-trade/inboxd.json" wake_0123456789abcdef0123456789abcdef
```

For model-led provisioning and the exact DSH environment variables, read
[`../../AGENT_SETUP.md`](../../AGENT_SETUP.md). Ask the human only for external account creation or
local secret authorization; perform repository installation and verification from the agent.

## Local runtime trigger

`trigger.mode = "command"` is an optional bridge to OpenClaw, Heron, Codex, a local model, or a
custom dispatcher. The command is run without a shell and receives only the trusted local task
path through `{task}` and `AGENT_TRADE_WAKE_TASK`. Untrusted email body is not placed in argv or
the environment. Command triggers are serialized; receipt and durable queueing remain independent
from model execution.

There is no ten-second poll timer. The daemon maintains an outbound AgentMail WebSocket and uses
bounded exponential delay only after a disconnect. Provider redelivery is absorbed by the
deterministic message-based queue key.
