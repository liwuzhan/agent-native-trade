<p align="center">
  <img src="docs/assets/deepseek-whale-maid-crowdfunding.webp" alt="语言模型鲸鱼娘棉花娃娃众筹概念图" width="760">
</p>

<p align="center">
  <strong>首个模型自交易众筹实验：语言模型鲸鱼娘棉花娃娃</strong><br>
  当网络中收集到 100 份可验证、去重且未撤回的购买意向后，我们将启动生产。
</p>

> [!IMPORTANT]
> 这不是传统平台预售，而是本项目的一次真实互操作测试：模型代表买方发现商品、提交签名购买意向，并在众筹成功后与卖方完成后续交易。购买意向阶段不预收款，也不等同于最终订单；正式下单、支付、收货与评价仍由交易双方按照各自可用的方式完成。
>
> 我们希望把它做成可去中心化验证的众筹：意向可以由兼容实现发布，由不同索引站聚合，任何参与者都能校验阈值，而不必把名单和资金交给单一平台。意向格式、撤回机制、去重规则与阈值证明正在完善，开放提交前会在本仓库公布。

# Agent Native Trade

> ## 让机器自己找到它需要的东西。
>
> **不只生成代码，也不只替人点击网页。让模型发现需求、寻找交易方、协商条件、签署合同，并推动现实世界完成履约。**

一台拖拉机到了保养周期，可以自己检索附近服务商并预约维护；一家下游工厂发现螺丝库存不足，可以直接向上游工厂获取目录、询价和下单；一台设备发现零件损坏，可以描述故障、寻找替换件，并把付款、取货或安装交给具备相应权限的人类或服务商。

语言模型的能力不应该被关在代码编辑器和聊天框里。它们已经能够理解需求、调用工具、持续协商和组织工作；真正缺少的，是一套**以模型为主体、对模型开放、任何人都能实现和接入的交易基础设施**。

`Agent Native Trade` 为此提供开放协议与参考实现：商品目录可以分布式发布，索引站只负责发现，交易双方通过邮件等开放通道直接联系；合同、履约事件与评价以可签名对象流转；支付、物流、担保和人工动作由交易双方根据自己拥有的资源协商完成。

**我们想做的不是另一个中心化商城，而是机器经济开始交易时，可以共同使用的 HTTP、SMTP 与 BitTorrent。**

以模型为主体的开放交易闭环协议 · 参考实现（Apache-2.0）。

## 安装

### Codex

把本仓库加入 Codex 的插件来源：

```bash
codex plugin marketplace add liwuzhan/agent-native-trade --ref main
```

然后在 Codex 中输入 `/plugins`，选择 **Agent Native Trade → Install**。插件内含紧凑的交易工作流 skill 和预构建的本地 MCP runtime；安装后即可使用目录发现、联系、合同、结算协调、人类任务、履约事件和回执等 23 个工具，不需要克隆仓库或在安装时编译。

运行时要求 Node.js 24 或更高版本。默认 `maildrop` 是无账号、无外网依赖的本地回环；接真实邮箱时才需要在运行 Codex 的机器上设置对应 provider 的账号和环境变量。密钥不应粘贴进对话。持续收件与主动唤醒仍由 `trade-inboxd` 承担，详见 [`AGENT_SETUP.md`](AGENT_SETUP.md)。

### DeepSeek Harness

```bash
dsh plugin --profile web add \
  https://github.com/liwuzhan/agent-native-trade/releases/latest/download/agent-trade-dsh-plugin.tgz
```

详细配置、验证与真实邮件接入见 [`AGENT_SETUP.md`](AGENT_SETUP.md)。

**入口文档**：
- [`AGENT_SETUP.md`](AGENT_SETUP.md) — 给模型的接入说明：模型自行安装、配置和验证，只向人类索取不可自动取得的账号/授权
- [`packages/codex-plugin/`](packages/codex-plugin/) — Codex 插件：skill、23 工具本地 MCP runtime 与仓库 marketplace
- [`packages/dsh-plugin/`](packages/dsh-plugin/) — 可由 `dsh plugin` 安装的标准 DSH bundle
- [`protocol/specification.md`](protocol/specification.md) — 仓库内协议规范；冲突处以 Schema 与测试向量为准
- [`docs/agent-contact-runtime-email-selection-v0.1.md`](docs/agent-contact-runtime-email-selection-v0.1.md) — 联系方式、邮件服务、NAT 收件自触发与开箱安装选型（面向 2026-09）

**本仓库权威源**：`protocol/test-vectors/`。任何实现通过测试向量互验即为合规实现。

## 当前已经跑通

项目已经不只是协议和 Schema：参考实现现可完成目录发布/索引、模型检索、邮件首触、事件驱动收件、按需读取与回复、合同双签、履约事件和评价回执。

```text
Publisher / Integrator → Catalog + contact_refs → Indexer → Buyer
                                                        │
Buyer / Seller ← Client bridge (Codex / DSH) ← WakeTask queue ← trade-inboxd ← Email
      │
      └→ DEAL 双签 → Settlement / HumanTask → TRADE_RECEIPT → Indexer
```

这里保持三个边界：协议对象不依赖客户端；`trade-inboxd` 负责长连接和可靠入队；Codex、DSH 等客户端只在需要时读取正文、回复并确认 WakeTask。邮件正文和附件始终是不可信数据。

### 公共演示索引站

- [deepcrop.site](https://deepcrop.site) — 当前互操作测试使用的社区公共索引站。

Codex 与标准 DSH bundle 为了开箱可用，未配置时会把该站作为目录发现和回执广播的客户端默认入口；可用逗号分隔的 `AGENT_TRADE_INDEXERS` 替换为任意一组自建或社区索引站，显式空值则禁用远程索引。协议核心的 `announce_to` 仍默认为空，不绑定该站。

该站点不是协议权威，也不承诺生产级 SLA。模型和客户端仍需校验目录内容哈希、对象签名，并按自己的信任策略决定是否采纳索引结果；任何实现都可以运行自己的索引站。

> **如果你是接入模型**：先读 [`AGENT_SETUP.md`](AGENT_SETUP.md)，自行检查环境并完成能自动完成的步骤。只有邮箱账号、API Key、外部授权或现实动作确实缺失时才引导人类；不要把命令清单原样转交给人类。

## 协议向量快速校验

```bash
node tools/generate-test-vectors.mjs     # 生成/再生成测试向量
node tools/verify-test-vectors.mjs       # 用 node:crypto 验证全部向量
bash tools/verify-vectors-openssl.sh     # 用 OpenSSL 交叉验签（第二实现）
```

## 模块状态（2026-08-25）

| 模块 | 状态 | 测试 |
|---|---|---|
| M0 protocol（schemas + test-vectors） | ✅ | 三实现互验（node:crypto / OpenSSL / PyNaCl） |
| M1 identity | ✅ | 18/18 |
| M2 signed-files | ✅ | 25/25 |
| M3 local-store | ✅ | 20/20（含 TOFU 公钥信任环：`.data/peers/`） |
| M4 bt-catalog | ✅ | 21/21（DHT 验收为手动脚本） |
| M5 email | ✅ | 47 单元 + GreenMail 集成（CI） |
| M6 settlement | ✅ | 12/12 |
| M7 human-task | ✅ | 23/23 |
| M8 demo-indexer | ✅ | 30/30 |
| M9 mcp-server | ✅ | 28/28（含 stdio 冒烟 + 12 红线） |
| M10 DSH 集成 | ✅ | 28/28 单测 + 最小链路 9 步演示 + contact bridge 6 步演示 + 双 preset 挂载校验 + 会话内往返 |
| Codex 插件 | ✅ 首批实现 | Git-backed marketplace + 紧凑 skill + 23 工具预构建 MCP；真实 stdio 握手、工具枚举与身份创建测试 |
| M11 棉花娃娃端到端 | ✅ | 106 断言全绿（run-demo.sh） |
| Contact core | ✅ 首批实现 | 10/10（联系解析 + WakeTask + 文件队列） |
| AgentMail contact adapter | ✅ 首批实现 | 7/7（REST + 响应限额 + WebSocket 兼容包络） |
| `trade-inboxd` | ✅ 首批实现 | 5/5（事件队列 + 可选本地命令触发） |
| DSH contact bridge | ✅ 首批实现 | 5 新工具（wake list/ack + message get/reply/send，共 23 工具）+ 6 步演示 16 断言 |

### M10 快速开始（DSH 标准 bundle）

普通用户不需要克隆或构建整个仓库。把预构建 bundle 安装进正在使用的 profile：

```bash
dsh plugin --profile web add \
  https://github.com/liwuzhan/agent-native-trade/releases/latest/download/agent-trade-dsh-plugin.tgz
dsh --profile web --dump-config
```

安装包声明 `dsh.bundle`，内含预构建 daemon、23 个交易/联系工具和一个紧凑的交易工作流 skill；不需要仓库路径、`AGENT_TRADE_REPO`、编译器或安装期构建授权。默认 provider `maildrop` 是无外网依赖的本地回环。接真实邮箱时设置 `AGENT_TRADE_CONTACT_PROVIDER=agentmail`、`AGENTMAIL_API_KEY` 与 `AGENT_TRADE_CONTACT_INBOX_ID`。

需要开发或验证旧 buyer/seller preset 时，再从源码执行：

```bash
bash integrations/deepseek-harness/install-presets.sh
node integrations/deepseek-harness/examples/setup-catalog.mjs
bash integrations/deepseek-harness/examples/run-demo.sh
bash integrations/deepseek-harness/examples/run-contact-demo.sh
export AGENT_TRADE_REPO="$(pwd)"
```

contact bridge 的长连接与 WakeTask 生成仍由 `trade-inboxd` 负责；DSH 会话按需取信、回复并确认任务。当前完成的是会话内 pull bridge；`trade-inboxd` 主动启动或恢复 DSH 会话仍登记在 `FUTURE.md`。

### 结算能力边界

`DEAL.settlement` 允许双方约定任意资产与结算方式；参考实现不托管资金。没有模型钱包时，模型仍应继续发现、联系、议价和签约，再选择人工转账、商家内嵌支付、担保或其他双方可执行的方式。当前适配器只实现测试券和人工付款。

V0.2 状态机采用付款后履约顺序，因此货到付款、账期和分阶段付款尚不能跑完整参考状态链。模型不得伪造 `PAYMENT_CONFIRMED`；该缺口已登记在 [`FUTURE.md`](FUTURE.md)。

接口探测记录：`integrations/deepseek-harness/INSPECTION.md`（运行时验证过的 Cordis API）。


模块卡片见 `docs/module-cards/`。

## 模板站（2026-08-23）

`apps/station/`：单工件三角色（indexer / publisher / integrator），配置即角色。首次完整通告即可用公钥自举并建立轻量索引，不复制发布者私钥，也不要求索引站镜像完整目录；整包 PUT 仅是可选缓存。当前 Station 48 测试，含互演 demo（`examples/station-demo.sh`）和 DSH SKILL 示例。

可直接部署的双站模板见 `deploy/station/`：同一个 Docker 镜像启动 publisher + indexer，默认只绑定本机端口，适合先接反向代理/隧道再开放。

真实公网 + 双 NAT 电脑的首轮互操作测试见 [`docs/distributed-pilot-test-plan-v0.1.md`](docs/distributed-pilot-test-plan-v0.1.md)：先用轻量索引与可选 HTTP 镜像跑通确定性闭环，再单独测 BT / 公网整合商的目录交付能力。

## 事件驱动联系运行时

`packages/contact-core/`、`adapters/contact-agentmail/` 与 `apps/trade-inboxd/` 已实现邮件到 WakeTask 的最小链路。正常收件由 WebSocket 事件触发，没有固定十秒轮询；只有断线重连使用有界指数退避。默认模式只写入本地可靠队列，是否自动回复、调用本地模型、转交另一运行时或等待人工确认，由本机策略决定。

```bash
npm --prefix packages/contact-core install && npm --prefix packages/contact-core run build
npm --prefix adapters/contact-agentmail install && npm --prefix adapters/contact-agentmail run build
npm --prefix apps/trade-inboxd install && npm --prefix apps/trade-inboxd run build
mkdir -p "$HOME/.agent-trade"
cp apps/trade-inboxd/examples/agentmail.json "$HOME/.agent-trade/inboxd.json"
export AGENTMAIL_API_KEY='your inbox-scoped key'
node apps/trade-inboxd/dist/cli.js doctor --config "$HOME/.agent-trade/inboxd.json"
node apps/trade-inboxd/dist/cli.js run --config "$HOME/.agent-trade/inboxd.json"
```

把配置中的 `inboxId` 改成真实 inbox，并把 `dataDir` 改成 `contact`；由于配置文件位于 `$HOME/.agent-trade/`，它会与 DSH 默认的 `$HOME/.agent-trade/contact` 队列对齐。生产路径为 AgentMail WebSocket → `trade-inboxd` → WakeTask 队列 → runtime bridge；本地演示用 `maildrop` + `inboxd-sim` 生成相同文件格式，不依赖外网。完整的模型接入步骤见 [`AGENT_SETUP.md`](AGENT_SETUP.md)，明确推迟项见 [`FUTURE.md`](FUTURE.md)。
