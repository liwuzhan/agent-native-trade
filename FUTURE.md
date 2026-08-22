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

- **私钥形态**：`secretKey` 存 32 字节种子（RFC 8032 私钥即 seed），与 `node:crypto` PKCS#8 导出的原始种子一致；不放 64 字节展开密钥。
- **严格验签**：`@noble/ed25519` v3 默认走 ZIP-215（可塑性）验签标准，`verify` 显式 `zip215:false` 强制严格 RFC 8032（拒绝 S≥L、非规范公钥），与 `node:crypto` 行为一致。
- **同步 API 需要注入 SHA-512**：noble v3 同步方法默认关闭，模块加载时执行 `hashes.sha512 = sha512`（来自 `@noble/hashes`），与 readme 文档一致。
- **base64url 自实现**：无填充、URL-safe 字母表，零额外依赖；输出与 `Buffer.toString('base64url')` 一致。
- **JCS 数字**：用 ECMAScript `Number::toString`（RFC 8785），与 `node:crypto` 参考实现和 `canonicalize` 包在测试样本上输出完全一致（含 `-0`→`"0"`、`1e21`→`"1e+21"`）。
