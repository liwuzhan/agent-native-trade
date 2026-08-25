# Agent Trade for DeepSeek Harness

This is the installable DeepSeek Harness bundle for the
[agent-native-trade](https://github.com/liwuzhan/agent-native-trade) protocol.
It adds 23 catalog, contact, deal, event, receipt, settlement, and human-task
tools plus one compact workflow skill to an existing DSH profile.

## Install

Install the prebuilt release tarball into the profile you use:

```sh
dsh plugin --profile web add \
  https://github.com/liwuzhan/agent-native-trade/releases/latest/download/agent-trade-dsh-plugin.tgz
```

The package is self-contained: it does not need a repository checkout,
`AGENT_TRADE_REPO`, a compiler, or an install-time build permission. Its local
loopback maildrop works without an external account.

To use AgentMail instead, configure the DSH process environment:

```sh
export AGENT_TRADE_CONTACT_PROVIDER=agentmail
export AGENTMAIL_API_KEY=...
export AGENT_TRADE_CONTACT_INBOX_ID=...
```

Optional identity and storage settings:

```sh
export AGENT_TRADE_AGENT_ID=agent_buyer
export AGENT_TRADE_DATA_DIR="$HOME/.agent-trade/buyer"
```

Catalog discovery and receipt announcements default to the community indexer. Replace or disable that client default before starting DSH when needed:

```sh
export AGENT_TRADE_INDEXERS='https://deepcrop.site,https://another-indexer.example'
# export AGENT_TRADE_INDEXERS=''  # disable remote indexers
```

Secrets belong in the machine's environment or secret store, never in the
profile patch, model prompt, repository, or trade artifacts.

## Verify a local checkout

```sh
node packages/dsh-plugin/scripts/build-bundle.mjs
npm test --prefix integrations/deepseek-harness/plugin
cd packages/dsh-plugin
mkdir -p release
npm pack --pack-destination release
dsh plugin --profile agent-trade-smoke add \
  ./release/agent-trade-dsh-integration-0.2.0.tgz
dsh --profile agent-trade-smoke --dump-config
```

The dump must contain both `agent-trade-tools` and `agent-trade-skills`.

## Compatibility

- Node.js 24 or newer.
- DeepSeek Harness versions compatible with
  `@deepseek-ai/dsh-skill-filesystem` 0.1.1 prereleases or 0.1.x stable.
- The legacy buyer/seller preset installer remains supported; when it supplies
  `AGENT_TRADE_REPO`, the plugin uses the checkout daemon for development.
