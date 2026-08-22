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
