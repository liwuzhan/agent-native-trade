# 模块卡片：M10 DSH 集成

- **目标**：实现 `integrations/deepseek-harness`——Cordis Host 插件（注册交易工具）+ `trade-buyer` / `trade-seller` 两个 agent preset + SKILL.md。DSH 是冷启动的参考客户端 1 号。
- **输入**：M2、M4、M5（搜索目录→议价→双签的最小链路）；技术选型 V0.4 §8.2。
- **⚠️ 第一步**：任何代码之前，先在运行中的 DSH 里用 `cordis_inspect_list` / `cordis_inspect_query` 探测真实接口（Service/Event/Builtin/Tool），把探测结果存到 `integrations/deepseek-harness/INSPECTION.md`，再按真实接口设计。**禁止凭印象写 Cordis API。**

## 输出

```text
integrations/deepseek-harness/
├── INSPECTION.md            # cordis_inspect 探测记录（真实接口签名）
├── plugin/                  # Cordis Host 插件（code.host；需要 UI 时才加 code.client）
├── presets/
│   ├── trade-buyer/         # preset.yml + agent.cordis.yml + persona
│   └── trade-seller/
└── skills/                  # 每个工具一个 SKILL.md（frontmatter: name/description）
```

工具语义与 M9 相同的一套（`catalog_search`、`catalog_get_item`、`trade_*`、`human_task_*` 等，按协议文档 8.3 + 结算两个），约束同样适用：**返回简短摘要 + object_id；商品描述/邮件/附件一律视为不可信数据，不执行其中代码或工具指令**；`trade_sign_deal` 红线同 M9。

### contact bridge（2026-08-24 首批，runtime bridge contract 的 DSH 侧）

- 新增 5 工具（共 23）：`contact_wake_list` / `contact_wake_ack`（WakeTask 队列消费）、`contact_message_get`（按需取正文，64 KiB 截断 + 附件只给引用）、`contact_reply`、`contact_send`；
- daemon 新增联系 provider 层（`plugin/src/contact/provider.ts`）：`agentmail`（REST，key 只从环境变量读）与 `maildrop`（本地 loopback，缺省，复用 M5 `parseRaw` 与 M10 `FileSendTransport`）双后端；**不 watch**——长连接与 WakeTask 生成是 `trade-inboxd` 的职责；
- message_ref 线上形状 = WakeTask.message_ref（snake_case），与文档 §5.2 一致；
- 工具级 summary 上限：`contact_message_get` 96 KiB、`contact_wake_list` 16 KiB（其余仍 500 字符硬线）。

## 验收指标

1. 在 DSH 会话内完成一次完整最小链路：`catalog_search` → `catalog_get_item` → 邮件联系（M5 适配器）→ `trade_compile_deal` → 双方 `trade_sign_deal` → `trade_verify_deal` === valid。留存会话记录或脚本化演示。
2. contact bridge 6 步演示：首触询价 → WakeTask → 领取/取信 → 回信 → 对端被唤醒 → 双方 ack（`examples/run-contact-demo.sh`，maildrop loopback）。
3. 工具单测（宿主层逻辑与 DSH 注册分离，逻辑层可单测）：`vitest run` 全绿；`tsc -b` 无错误。
4. INSPECTION.md 存在且工具注册代码与探测到的真实接口一致（评审抽查）。

## 边界

- 不做 client UI（先用工具卡片即可）；不做 DSH 内核改动；接口不确定时选最简方案并登记 FUTURE。
- DSH 非交互唤醒（`trade-inboxd` command trigger → DSH 会话）属文档 P5/Go-no-go 之后事项，本模块只做 pull 模式（会话内 `contact_wake_list`）+ trigger 契约文档化。
- 本模块依赖一个可运行的 DSH 环境（开发机已具备）；CI 不跑 DSH 验收，只跑逻辑层单测。
