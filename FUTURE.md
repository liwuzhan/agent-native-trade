# FUTURE（明确推迟，按优先级）

1. **密钥轮换/吊销声明文件**（旧钥签新钥）——丢钥丢的是身份之后历史的伪造能力，玩票阶段结束后最先补。
2. 选择性披露（Merkle/redaction：证明合同存在且满足某条件而不公开条款）。
3. 真实秘密的加密传输（加密附件适配器）。
4. 真实邮箱投递优化（进垃圾箱/限流/账户风控）。
5. 区块链/上链时间戳；自建钱包与支付资产；完整 DHT 实现；全局信用分。
6. 自建保险/担保/仲裁系统（只留 ref 引用位，等其自然长出来）。
7. 自动反垃圾、统一 SEO、自动物流下单、高频交易优化。
8. 一条评价一个 torrent 的传播方式（已用批次 Feed 替代）。
9. 与 x402 / AP2 / ACP 等 agent 支付协议的桥接（settlement.provider_ref）。

## 取舍登记（M1 identity）

- @noble/ed25519 v3 默认验签标准为 ZIP-215（宽松）——`verify` 显式 `zip215:false` 强制严格 RFC 8032，S+L 可塑性测试证明生效。
- noble v3 同步方法默认关闭，模块加载时注入 `hashes.sha512 = sha512`。
- 私钥采用 32 字节种子（与 node:crypto PKCS#8 导出一致）。
- base64url 为包内自实现（已与 Buffer 逐长度对拍），避免额外依赖。
- dev 依赖在卡片字面清单（vitest + canonicalize）外另含 typescript（tsc -b 必需）与 @types/node（测试 typecheck），运行时依赖仍严格只有两个 noble 包。

## 取舍登记（M3 local-store）

- tsconfig 增加 `esModuleInterop: true`（better-sqlite3 类型为 `export=`，NodeNext ESM 必需）。
- `getObject` 直读事实文件而非索引——签名文件是唯一事实源，索引缺失时读仍正确。
- 索引仅 events+trades 两表，全部可由 objects/ 推导；`rebuildIndex` 采用关库→删文件→重开→全量重建，重放顺序 (occurred_at, event_id)。
- `applyEvent` 防御性校验 body.trade_id 与参数一致；线性链事件仅允许自紧邻前驱状态迁移（"付款事件不越级"）。
- 信任环 = saveKey 存入的私钥派生公钥，跨 close/reopen 持久。

## 取舍登记（M4 bt-catalog）

- **webtorrent 固定 1.9.7**（原生依赖问题）：webtorrent 3.x 通过 `@thaunknown/simple-peer` 引入 `node-datachannel`（原生 WebRTC 插件），其 prebuild 需从 GitHub Releases 下载，而本环境 `github.com` 不可达导致安装超时失败。1.9.x 的 `simple-peer` 为纯 JS、唯一原生依赖 `utp-native` 的 prebuild 随 npm 包内置（`node-gyp-build` 本地选取，无网络下载），安装零失败。BT 的 TCP 传输不依赖 WebRTC，功能不受影响。
- **未引入 create-torrent / magnet-uri**（卡片允许确认 API 不足后登记）：已确认 webtorrent 自带二者——`client.seed` 内部用 create-torrent 生成 `.torrent` 与 infoHash，`torrent.magnetURI` 由内置 parse-torrent/magnet-uri 生成并携带 `tr=` announce，`torrent.torrentFile` 直接可得。API 足够，无需新增依赖。
- **startTracker 固定 5s announce 间隔**（默认 10 分钟）：本地 tracker 只用于测试；若下载方首次 announce 早于做种方，10 分钟间隔会挂死往返测试，5s 让错过的 announce 自愈。
- **`dht` 选项**：卡片签名只列 `tracker`，但往返验收要求"DHT 关闭"。`seed`/`download` 的 opts 扩展了可选 `dht?: boolean`（默认 true）；测试显式传 `dht: false`。`lsd` 一律关闭（减少组播噪音）。
- **字节序排序**用 `Buffer.compare`（UTF-8 字节序，规范要求），非 UTF-16 码元序——BMP 外二者不一致，单测覆盖。
- **verifyCatalogFiles 为子集语义**：manifest 内每项必须存在且哈希一致，未列出的多余文件忽略（catalog_hash 只约束 manifest 内容）。
- webtorrent / bittorrent-tracker 均无 TS 类型：src 内置窄版 ambient 声明（仅本地编译用，`declaration` 输出会剔除实现内 import，dist 的 .d.ts 零引用第三方类型，消费方无需额外 @types）。
- dev 依赖在卡片字面清单（bittorrent-tracker + vitest）外另含 typescript（tsc -b 必需）与 @types/node（测试 typecheck），运行时依赖为 webtorrent + @agent-trade/identity，与 M1 登记口径一致。

## 取舍登记（M5 email）

- `OutboundMsg` 增加可选 `inReplyTo`（线程关联）；发件人由 smtpUrl 用户推导。
- `createMailAdapter(config, deps?)` 增加可选测试注入参（MailboxSource/SendTransport/SeenStore/fetchTrace），单参调用与卡片签名一致。
- 附件超限"拒绝落地但消息仍投递"（附件从列表剔除）；同名附件 -1/-2 后缀去重；无 Message-ID 时回退 imap-uid-<uid>@localhost。
- 待办候选：邮件处理后的 \Seen/归档策略、uidValidity 处理、IMAP 重连策略。
- GreenMail 集成测试本机无 Docker 未执行，由 CI 的 greenmail service 执行（greenmail/standalone:2.1.0，SMTP 3025 / IMAP 3143）。

## 取舍登记（M6 settlement）

- `markFulfilling` 为模块级导出函数（卡片接口块未列，按"适配器提供"处理）。
- `request` 同步执行 applyEvent（状态机需先到 PAYMENT_PENDING 才能 confirm）。
- manual-settlement 的 `confirm` 自建并签发 PAYMENT_CONFIRMED，不调用 M7 的 toEvent（M7 并行开发，仅按 HumanTaskStore 接口注入；任务须存在且 DONE）。
- test-voucher 凭证登记为适配器实例级内存注册表，不持久化（虚构凭证）。
- 秘密扫描范围含 .data/objects 与 index.sqlite；keys/ 有意排除（0600 私钥环，非公开数据）。

## 取舍登记（M7 human-task）

- `createHumanTaskStore(store, opts?)` 增加可选 `opts.dir`（Store 接口不暴露数据根目录，缺省落 process.cwd()）；M6/调用方接线时传 `{ dir }` 指向同一 .data/ 根。
- toEvent 要求签发者公钥先经 `store.saveKey` 注册（M3 信任环统一要求）。
- tasks 镜像表用 Node 内置 `node:sqlite`（Node 25 打印 ExperimentalWarning，已抑制）——注意它与 M3 的 better-sqlite3 是**两个 sqlite 绑定访问同一 index.sqlite 文件**；测试全绿，若未来出现 SQLITE_BUSY 再统一到一个绑定。
- tasks 表是可丢弃镜像，M3 `rebuildIndex()` 后由本适配器惰性重建。
- task_id 全入口强制 uuid v7 格式（路径穿越防护）；额外导出 uuidv7 工具。

## 取舍登记（M8 demo-indexer）

- 快照签名用协议外类型前缀 `INDEX_SNAPSHOT`（不新增协议类型）；快照 = plain JSON + detached .sig，站点公钥写入快照 body 使离线验签自含。
- signed-files 未导出 signingInputBytes，snapshot.ts 内 10 行复刻 spec §2 布局（后续若多个模块需要，应上提为 signed-files 公共导出）。
- 证据档位（bundle/referenced/none）在收录时判定为事实，权重只重新定价；weights.json 含缺失 deal_ref/结算事件的罚分项。
- 去重 = body_hash 唯一 + receipt_id 唯一（同 id 异内容 → HTTP 409）。
- 回执索引/目录存档在自有 .data/receipts.sqlite（local-store 只承担事实文件+信任环+站点身份）。
- 额外提供 `indexer serve` 子命令（卡片 CLI 只列 export/query）。

## 取舍登记（M9 mcp-server）

- `trade_sign_deal` 增加可选 `signer` 参数（本机多密钥环选钥，签名面仍严格 deal+expected_body_hash，调用方不能提供密钥）。
- sign 成功后经 putObject 持久化 signed deal；verify/settlement 支持 deal 对象或 object_id 二选一（配合"响应不返回完整文件"）。
- body schema 由 scripts/extract-body-schemas.mjs 从 protocol/schemas 提取（整信封 schema 要求 signatures≥1，无法验未签草稿）；schemas-sync 测试防漂移；运行时复用 MCP SDK 内置 AJV，未新增 ajv 依赖。
- 无签名对象的工具 object_id 语义：identity → `identity:<agentId>`、status → trade_id。
- manual-settlement 用进程内 InMemoryHumanTaskStore（M7 接口注入）；confirm 要求 PAY 任务 DONE，无工具代完成（人工在环）。

## 取舍登记（M11 棉花娃娃端到端）

- GreenMail 模式已实现未实测（本机无 Docker）：`RUN_MODE=greenmail` 走 M5 真实 SMTP/IMAP，待 CI 有 Docker 时补跑。
- MCP 仅用于 DEAL 生命周期（起草/签/审签/记录/验签），其余步骤包直调——符合"包 + MCP 编排"口径。
- 事件 object_id 非确定性（uuidv7/now），权威值见 runlog/demo-summary.json；演示未调用 rebuildIndex（避免同毫秒重放抖动，M3 测试已覆盖该特性）。
- 人类步骤由演示脚本自动标记完成；整合商由第二索引器实例扮演；整合商身份为硬编码虚构固定种子。
- 修复记录：lib/mcp.mjs 相对路径层级错误导致 MCP 子进程秒退（已改 ../../../）；MCP 子进程 stderr 需排空防阻塞。

## 取舍登记（M11 健壮性加固 & DHT 验收结果）

- demo 11 步各包 30s 硬超时；BT 播种/下载单独 20s（`lib/bt-bounded.mjs`，超时销毁 webtorrent 客户端）；HTTP 15s；全局看门狗 300s。
- BT 下载失败降级到索引站 HTTP 镜像（`BT_MODE=mirror` 强制降级路径已验证：108 断言全绿）。
- **BT 下载在部分环境可能偶发挂起**：本环境未复现、根因未定位，已用超时+镜像降级兜底（M11 子代理排查有界结论）。
- **M4 DHT 真实网络验收在本环境失败**（2026-08-23）：卖方播种+宣告流程走完，买方仅 magnet 120s 超时；本环境 github.com 不可达，判断为公共 DHT bootstrap 被网络策略拦截所致，非实现问题。**发布前必须在开放网络复跑 `packages/bt-catalog/scripts/dht-acceptance.mjs`**。

## 取舍登记（M10 离线预备）

- preset/skill/INSPECTION.md 基于打包安装目录的真实样例离线起草；cordis 插件宿主代码零行——动态工具注册的确切接口属"运行时待探测"（INSPECTION.md 第二部分 14 条），需在运行中的 DSH（创造模式会话）用 cordis_inspect_list/query 逐项验证后填写。
- agent.cordis.yml 只含逐字取自打包样例的已验证行；交易工具挂载留 TODO(runtime) 占位。
- M10 会话内验收（搜索→议价→双签）必须在真实 DSH 环境执行，不进 CI。

## 取舍登记（M10 DSH 集成完成，2026-08-23）

- **架构**：零依赖静态插件（plugin.mjs，随 preset 目录分发，行 `name: './plugin.mjs'`）+ 仓库内 JSONL daemon（subprocess stdin pipe）持 TradeApp 单例；逻辑层复用 M9 handlers（mcp-server 增子路径导出），密码学/红线全在 daemon。依据：动态插件沙箱无 crypto/Buffer/process（INSPECTION.md B8）。
- **M3 信任环扩展**：`.data/peers/<agentId>.pub` 只读公钥导入（keys/ 私钥派生优先）——跨进程双签验证必需；加法变更、M3 原有 19 测试不动。
- **trade_contact_seller**：本地走 file-maildrop loopback（跨进程共享 spool 目录），生产换 SMTP/IMAP URL（M5 注入缝）；支持 JSON 附件（DEAL 信封传递路径）。
- **trade_broadcast_receipt**：打包+本地做种（dht 关，可选本地 tracker）；下载侧接线（M8）与 DHT 传输登记 FUTURE（本环境 DHT 受限，见上方 M4 条目）。
- **动态沙箱教训**：`ctx.clearTimeout` 不存在（timer 用 disposer 返回），流回调未兜底会带崩宿主进程——INSPECTION.md D11 已记；静态插件不受限。
- **未做**：client UI（工具卡片默认呈现）、Event 通知、真实 SMTP/IMAP 配置化接入（env 占位）、toolTimeout 超时后的 daemon 优雅重启策略（当前 terminate 后下次重建）。
- **人工验收项**（发布前）：真实 preset 会话各开一买方/卖方跑通 demo（persona 生效、技能目录可见性、tool 列表 18 工具）——standingKeyFor 挂载校验已过，但真实会话呈现待人工确认（INSPECTION.md A5/D12）。
