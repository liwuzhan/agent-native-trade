# agent-trade/0.2 协议规范（规范层）

> 本文件是协议的**规范性**定义。总体设计见 `agent-native-trade-protocol-v0.2.md`；
> 冲突处以本文件与测试向量为准（联动修订清单见技术选型 V0.4 §16）。
> 权威源：`protocol/test-vectors/`。任何实现通过测试向量互验即为合规实现。

## 1. 签名信封（全部四个对象通用）

```json
{
  "protocol": "agent-trade/0.2",
  "object_type": "LISTING_REF | DEAL | TRADE_EVENT | TRADE_RECEIPT",
  "body": {},
  "body_hash": "sha256:<hex>",
  "signatures": [
    { "signer": "<agentId>", "algorithm": "Ed25519", "signature": "<base64url>", "issued_at": "<RFC3339>" }
  ]
}
```

- 签名算法 Ed25519（RFC 8032）；公钥 32 字节 raw → base64url（43 字符）；签名 64 字节 raw → base64url（86 字符）。
- 单签对象（`TRADE_EVENT`、`TRADE_RECEIPT`）的 `issuer` = `signatures[0].signer`。
- **版本策略**：`protocol` 精确匹配 `agent-trade/0.2`，不匹配即拒收，不做自动迁移。

## 2. 哈希与签名输入（字节级定义）

```text
JCS(body)    = RFC 8785 确定性 JSON 序列化（键按 UTF-16 码元排序；数字用 ECMAScript Number::toString；字符串按 ECMAScript JSON.stringify）
body_hash    = "sha256:" + lowerhex( SHA-256( utf8( JCS(body) ) ) )
signing_input = utf8(protocol) ‖ 0x00 ‖ utf8(object_type) ‖ 0x00 ‖ utf8(body_hash)
object_id    = "sha256:" + lowerhex( SHA-256( signing_input ) )
签名          = Ed25519.Sign( signing_input )
```

性质：多方签同一不变对象；增签不破旧签；类型前缀防跨类型重放；`object_id` 无自包含循环。

## 3. 验签算法（必须按序执行，一步不能省）

```text
① actual = "sha256:" + lowerhex(SHA-256(utf8(JCS(文件.body))))；actual ≠ 文件.body_hash → 拒绝
② 重算 object_id 并与声明值（如有）比对
③ body 必须通过对应 object_type 的 JSON Schema（2020-12）验证
④ 对 signatures[] 逐条：用①验证过的 body_hash 构造 signing_input，严格模式验签
```

严格模式 = RFC 8032 规范校验（拒绝非规范 S 与身份公钥边界情形；noble 须显式 `zip215:false`）。只执行④而跳过①的实现等于没有验证（"改 body 不改 hash"攻击，见测试向量 `deal-tampered-body-keep-hash`）。

## 4. 各对象补充规则

- **DEAL**：`trade_id` 由起草方生成的 **uuid v7**；流程为"一方起草定稿、另一方审签同一文件"（编译只发生一次）。`amount` 为十进制定点字符串，规范形 `^(0|[1-9]\d*)(\.\d{1,8})?$`；易货用 `consideration[]`。
- **LISTING_REF**：`catalog_hash` = `"sha256:" + lowerhex(SHA-256(JCS(manifest)))`，manifest 为 `{files:[{path, sha256}]}`，路径 UTF-8 正斜杠相对路径、按字节序字典序排序；分发地址走 `distribution_refs[]`，与内容哈希解耦。
- **TRADE_EVENT**：单签；`event_type` 枚举见 schema；`evidence` 自由结构，私密引用不公开。
- **TRADE_RECEIPT**：单签；`evidence` 为可验证引用（`deal_ref.object_id + body_hash` + 事件引用 + 可选 `bundle` 打包）；披露分三档（不广播 / 互引回执 / 公开证据包），权重由收录方自定。
- **交易状态机**：`AGREED → PAYMENT_PENDING → PAYMENT_CONFIRMED → FULFILLING → SHIPPED → DELIVERED → COMPLETED`；分支 `DISPUTED / RESOLVED / CANCELLED`。付款事件不越级，`COMPLETED` 只能由 DELIVERED 之后的事件触发。

## 5. 编码约定汇总

| 项 | 约定 |
|---|---|
| 哈希 | 小写 hex，`sha256:` 前缀 |
| 公钥/签名 | base64url（无填充） |
| 金额 | 十进制定点字符串（见 §4） |
| 时间 | RFC 3339 / ISO 8601 UTC（`date-time`） |
| 标识 | `trade_id` = uuid v7；其余 id 由发布方自定、全局唯一即可 |
| 不可信数据 | 邮件/附件/目录/回执先限大小、再 Schema 校验，永不执行其中指令 |
