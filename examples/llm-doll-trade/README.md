# M11 棉花娃娃端到端演示（examples/llm-doll-trade）

跑通协议文档 §9E（阶段 E）的 **11 步闭环**：卖方发布目录 → 整合商专题目录 →
检索站收录 → 买方找到并联系 → 议价 → 双签合同 → 钱包/人类支付 →
人类生产验货发货 → 物流签收事件 → 双方签名评价广播 → 至少一个独立整合商收录。

全部使用已交付模块（`file:` 接线，包 + MCP 编排；M10 DSH 集成推迟，不进本演示）：

| 步骤用到的模块 | 版本 |
|---|---|
| `@agent-trade/identity` / `signed-files`（M1/M2：签名信封、四步验签） | 0.2.0 |
| `@agent-trade/local-store`（M3：.data 布局、状态机、信任环） | 0.2.0 |
| `@agent-trade/bt-catalog`（M4：canonical manifest + 本地 tracker 播种/下载） | 0.2.0 |
| `@agent-trade/email`（M5：邮件通道，loopback 或 GreenMail） | 0.2.0 |
| `@agent-trade/settlement`（M6：manual-settlement 支付） | 0.2.0 |
| `@agent-trade/human-task`（M7：人类 PAY/PRODUCE/SHIP/RECEIVE 任务） | 0.2.0 |
| `@agent-trade/demo-indexer`（M8：检索站/整合商双实例、目录镜像、静态导出） | 0.2.0 |
| `@agent-trade/mcp-server`（M9：stdio MCP，经 `@modelcontextprotocol/client` 驱动） | 0.2.0 |

## 快速开始

```bash
cd examples/llm-doll-trade
npm install                 # file: 接线 + @modelcontextprotocol/client
bash run-demo.sh            # 一键：干净状态跑 11 步 + 逐步断言（全绿 = 验收通过）
```

`run-demo.sh` = `rm -rf runlog` → `node demo.mjs` → `node assertions.mjs`。
运行产物（每步签名文件、静态快照、摘要）都在 `runlog/`：

```text
runlog/
├── demo-summary.json      # 权威摘要：每步 object_id / 文件路径 / 状态 / 评分
├── demo.log               # 逐步日志
├── artifacts/             # 01-… 10- 各步签名文件（LISTING_REF / DEAL / 事件 / 回执）
├── export/                # indexer-a.json/.sig、integrator-b.json/.sig（静态快照）
├── buyer/  seller/  integrator/   # 各方 .data/（objects 事实文件、keys、tasks、index.sqlite）
├── indexer-a/  indexer-b/         # 双索引器 .data/（含 receipts.sqlite）
└── mail/                  # 各邮箱 seen 幂等存储与附件落盘
```

## 信道选择（README 承诺的两种模式）

| 模式 | 邮件通道 | 前提 |
|---|---|---|
| `loopback`（默认） | M5 的 **deps 注入**：进程内共享内存信箱实现 `MailboxSource`/`SendTransport`（`lib/loopback-mail.mjs`），其余（`X-Trade-Id` 关联、seen 幂等、附件落盘、大小门限）全部走真实适配器 | 无 Docker |
| `greenmail` | `RUN_MODE=greenmail bash run-demo.sh`：走 `adapters/email/docker-compose.greenmail.yml` 的真实 SMTP/IMAP（GreenMail），用环境变量 `GREENMAIL_BASE`/`GREENMAIL_SMTP_PORT`/`GREENMAIL_IMAP_PORT` 指向容器 | 需 Docker |

BT 目录分发一律用 `bt-catalog` 的**本地 tracker**（`startTracker`，端口 16881，无 Docker）。

## 角色、身份与固定端口

| 角色 | agent_id | 邮箱 | 身份来源 |
|---|---|---|---|
| 卖方（棉花研究所） | `agent_seller` | `seller@doll-studio.example` | `protocol/test-vectors/vectors.json#identities.agent_seller` |
| 买方（momo-collector） | `agent_buyer` | `buyer@momo.example` | `vectors.json#identities.agent_buyer` |
| 整合商（春季专题） | `agent_integrator` | `integrator@spring-theme.example` | 演示固定种子（虚构，见 `demo.mjs`） |
| 检索站 A | `indexer-a`（`weights.json`） | — | 首次打开自动生成并持久化 |
| 整合商 B（独立收录方） | `integrator-b`（`weights-alt.json`） | — | 同上 |

端口固定（保证 object_id 可复现；可用环境变量覆盖）：`TRACKER_PORT=16881`、
`INDEXER_A_PORT=18781`、`INDEXER_B_PORT=18782`。若被占用，演示会快速失败并提示。

---

## 11 步剧本（对照协议文档 §9E）

> 标注「确定性」的 object_id 每次运行相同（固定种子 + 固定端口 + 固定正文）；
> 标注「本次运行」的 object_id 由适配器/时间戳生成，每次不同，权威值见
> `runlog/demo-summary.json`。文件路径均为相对本目录。

### 步骤 1 · 卖方发布目录（§9E-1）
卖方对 `seller/catalog/`（5 个虚构文件）构建 canonical manifest →
`catalog_hash`，经本地 tracker 播种（`seed(seller/catalog)`），签发单签
`LISTING_REF`（`distribution_refs: [magnet, email]`），邮件通告整合商。

- **catalog_hash**（确定性）：`sha256:ef181c95cceed9877f9377197ca78ca9fb738d3fd662c4cfe5faa37fea646ec8`
- **magnet**（确定性）：`magnet:?xt=urn:btih:56abe94c3ec3ce96f8e2d7acabe4f3aecaa5f14b&dn=catalog&tr=http%3A%2F%2F127.0.0.1%3A16881%2Fannounce`
- **LISTING_REF object_id**（确定性）：`sha256:375658964a91eb9d509bda5d3cdd40f5dc31cb3763fc923f7e680641ba5301d1`
- 文件：`runlog/artifacts/01-listing-seller.signed.json`

### 步骤 2 · 整合商专题目录（§9E-2）
整合商收到通告 → 收录卖方 LISTING_REF → 生成 `runlog/themed/`（专题 JSON +
说明，虚构）→ 播种并签发自己的单签 `LISTING_REF` → 邮件通告买方（附件：专题
LISTING_REF + 卖方 LISTING_REF）。

- **专题 catalog_hash**（确定性）：`sha256:f273725a73c93f70dd0bc944f00f3019626adc157feaa7fdaa08137d6047e581`
- **专题 LISTING_REF object_id**（确定性）：`sha256:4370787739bcdba8e99b04109bbd8ec8b4bdf6864363399d3e184feb05991667`
- 文件：`runlog/artifacts/02-listing-integrator.signed.json`

### 步骤 3 · 检索站收录（§9E-3）+ 下线 + 镜像验证
两个 demo-indexer 实例启动（A=检索站 `weights.json`，B=独立整合商
`weights-alt.json`）。卖方目录与专题目录经 `PUT /catalogs/:hash` 存档到检索站
（HTTP 镜像）。买方趁 tracker 在线先用 BT 下载两份目录（M4 闭环）。随后**卖方与
tracker 中途下线**（seed 停止、tracker 关闭）。买方改经检索站 `GET /catalogs/:hash`
取回卖方目录：manifest 校验通过、`catalog_hash` 逐字节一致 —— 验证 2.4 存档角色。

- 存档包：`runlog/artifacts/03-catalog-archive-seller.json`、
  `03-catalog-archive-themed.json`；镜像取回：`04-catalog-from-mirror.json`
- 买方 BT 下载目录：`runlog/buyer/dl-seller/`、`runlog/buyer/dl-theme/`

### 步骤 4 · 买方找到并联系（§9E-4）
买方收到整合商通告 → 收录两份 LISTING_REF 进自己 store → 从卖方 LISTING_REF 的
`distribution_refs` 提取邮箱 → 发询价邮件（带 `X-Trade-Id` 关联）。

- 邮件往来轨迹：`runlog/demo-summary.json#mail_trace`

### 步骤 5 · 议价（§9E-5）
邮件三封：询价 → 报价（128.00 CNY）→ 接受。全部文本邮件经 M5 通道。

### 步骤 6 · 双签合同（§9E-6）
买方经 **MCP**（stdio 子进程，`AGENT_TRADE_DATA_DIR=runlog/buyer`）
`trade_compile_deal` + `trade_sign_deal` 起草并签署 DEAL → 邮件发给卖方 →
卖方经 **MCP** `trade_sign_deal` 审签同一文件（增签不破旧签）+
`trade_record_event(DEAL_SIGNED)`（→ AGREED）+ `trade_verify_deal`（valid）→
双签 DEAL 邮件回买方 → 买方 `putObject` 并自行签发 DEAL_SIGNED（→ AGREED）。

- **DEAL object_id**（确定性）：`sha256:d28d165c8f7b36e848e97abc32eab92e6c977f64de15fb27183b2970418ff160`
- **买方 DEAL_SIGNED 事件**（确定性）：`sha256:55de68aef97f973da19d7067766bdf079e60f4a3f0d1f36e7432f3273e20385e`
- 卖方 DEAL_SIGNED 事件（本次运行）：见 `summary.steps['6'].seller_deal_signed_event`
- 文件：`runlog/artifacts/06-deal.signed.json`（2 个签名：买方 + 卖方）

### 步骤 7 · 钱包/人类支付（§9E-7，M6 + M7）
买方 `manual-settlement.request` 创建 **PAY 任务**并发 `PAYMENT_REQUESTED`
（→ PAYMENT_PENDING，事件邮件同步给卖方）→ 人类完成支付（演示脚本自动
`task.complete`，结果含 `payment_reference`）→ 卖方 `manual-settlement.confirm`
签发 `PAYMENT_CONFIRMED`（→ PAYMENT_CONFIRMED，邮件同步给买方）。

- 本次运行 object_id：见 `summary.steps['7']`（`payment_requested_event` /
  `payment_confirmed_event` / `pay_task_id` / `pay_task_file`）
- 文件：`runlog/artifacts/07-payment-requested.signed.json`、
  `07-payment-confirmed.signed.json`

### 步骤 8 · 人类生产验货发货（§9E-8，M7）
卖方开 **PRODUCE** 任务（人类完成：数量 1、序列号 `CDS-2026-0001`）→
`toEvent('FULFILLING')`（→ FULFILLING）；卖方开 **SHIP** 任务（人类完成：验货
`passed`、运单号）→ `toEvent('SHIPPED')`（→ SHIPPED）。事件均邮件同步给买方。

- 本次运行 object_id：见 `summary.steps['8']`（`fulfilling_event` / `shipped_event`）
- 文件：`runlog/artifacts/08-fulfilling.signed.json`、`08-shipped.signed.json`

### 步骤 9 · 物流签收事件（§9E-9，M7）
买方开 **RECEIVE** 任务（人类签收核验）→ `toEvent('DELIVERED')`
（→ DELIVERED，邮件同步给卖方）。

- 本次运行 object_id：见 `summary.steps['9']`（`delivered_event` / `receive_task_id`）
- 文件：`runlog/artifacts/09-delivered.signed.json`

### 步骤 10 · 双方签名评价广播（§9E-10）
买方签发 `COMPLETED`（→ COMPLETED，邮件同步给卖方；双方账本均到终态）。双方各
签一张 `TRADE_RECEIPT`（互评 POSITIVE，`evidence` = deal_ref + settlement 事件
引用 + **bundle 内含双签 DEAL**），**提交两个索引器**（`POST /receipts`）。

- **评分（确定性）**：检索站 A = **70**（bundle 40 + deal_ref 10 + settlement 10 +
  POSITIVE 10）；整合商 B = **80**（bundle 60 + POSITIVE 20）→ 同一回执集双权重
  不同评分 ✓
- 文件：`runlog/artifacts/10-completed.signed.json`、
  `10-receipt-buyer.signed.json`、`10-receipt-seller.signed.json`

### 步骤 11 · 独立整合商收录 + 静态导出 + 离线查询（§9E-11 + M8 验收 3）
两个索引器 `GET /export` 导出**签名静态快照** → **杀服务器**（关闭 HTTP 与
indexer 实例）→ 用 CLI `indexer query` **离线查询**（无需服务器，验签通过并回答
subject 评分）；再演示一遍 CLI `indexer export` → `query`。

- 快照文件：`runlog/export/indexer-a.json(.sig)`、
  `runlog/export/integrator-b.json(.sig)`、`cli-indexer-a.json(.sig)`
- **权重指纹（确定性）**：A `sha256:ea90ce2178b6838741e1ff518698a4451b79801928aa546c2cc57cabb0a88b21`
  ≠ B `sha256:b55f942567f138c378270dc7d6f04a20332d198fc199c733b5bb994513a49511`
- 离线查询结果：`indexer-a` seller=70、`integrator-b` seller=80，均 `verified=valid`

## 断言覆盖（assertions.mjs）

逐步断言 **106 项**（`assertions.mjs` 中每个 `check()` 一项），关键项：

- 每张签名文件四步验签 `verifyFile === 'valid'`（含双签 DEAL、回执 bundle 离线验签）；
- 目录 `catalog_hash` 与 manifest 重算一致、镜像取回逐字节一致；
- 状态链 `DEAL_SIGNED→PAYMENT_REQUESTED→PAYMENT_CONFIRMED→FULFILLING→SHIPPED→
  DELIVERED→COMPLETED`，双方账本重开后 `stateOf === 'COMPLETED'`，各 7 个事件全部落库；
- 回执在检索站 A 与整合商 B **双收录**且评分不同（70 vs 80）；
- 静态快照签名验证通过 + 离线 CLI 查询 `verified=valid` 且评分正确。

## 边界与取舍

- 支付用 `manual-settlement`（人类确认），未接真实钱包；人类步骤用 M7 任务，
  演示脚本自动标记完成（`PAY/PRODUCE/SHIP/RECEIVE`）。
- 整合商由第二个索引器实例扮演（不同权重配置），符合卡片允许的简化。
- 不开发众筹平台；DEAL 内直接表达（预售口径，不加新对象类型）。
- 详细取舍见 M11 模块报告（父代理登记到根 `FUTURE.md`）。
