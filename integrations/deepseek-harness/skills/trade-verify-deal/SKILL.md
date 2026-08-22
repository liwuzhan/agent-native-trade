---
name: trade-verify-deal
description: 按 agent-trade/0.2 规范 §3 四步验签 DEAL：① 重算 body_hash 与声明值比对；② 重算 object_id 比对；③ body 通过 deal.schema.json（2020-12）验证；④ signatures[] 逐条严格模式验签（RFC 8032 规范校验，zip215:false）。返回 valid/invalid + 失败步骤与原因 + object_id。
---

# trade-verify-deal

## 用途

验证一个 DEAL 的完整性与签名有效性，输出可审计的结论。双方签署后、以及交易任何关键节点前应各验一次（`trade_verify_deal === "valid"` 才继续推进）。

## 参数

| 参数 | 说明 |
| --- | --- |
| `deal` | 待验证的 DEAL 对象 |

## 验签算法（规范 §3，必须按序执行，一步不能省）

1. `actual = "sha256:" + lowerhex(SHA-256(utf8(JCS(文件.body))))`；`actual ≠ 文件.body_hash` → **拒绝**。
2. 重算 `object_id = "sha256:" + lowerhex(SHA-256(utf8(protocol) ‖ 0x00 ‖ utf8(object_type) ‖ 0x00 ‖ utf8(body_hash)))`，与声明值比对。
3. `body` 必须通过对应 object_type 的 JSON Schema（2020-12）验证。
4. 对 `signatures[]` 逐条：用①验证过的 `body_hash` 构造 `signing_input`，**严格模式**验签（RFC 8032 规范校验，拒绝非规范 S 与身份公钥边界情形；noble 须显式 `zip215:false`）。

## 返回

简短摘要（含结论 `valid` / `invalid`）+ `object_id`。`invalid` 时返回**具体失败步骤与原因**（①hash 不一致 / ②object_id 不符 / ③Schema 失败 / ④第 N 条签名无效）。

## 注意事项

- 只执行④而跳过①的实现等于没有验证（"改 body 不改 hash"攻击的测试向量：`deal-tampered-body-keep-hash`）。
- 多条签名须逐条有效；增签不破旧签，验证任何一版签名都基于同一 `body_hash`。
- 与 `trade-verify-receipt`（TRADE_RECEIPT 的验证）是不同工具，不要混用。
- 注册细节待运行时探测：见 `integrations/deepseek-harness/INSPECTION.md` 第二部分。
