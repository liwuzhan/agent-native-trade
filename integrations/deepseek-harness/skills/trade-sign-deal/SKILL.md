---
name: trade-sign-deal
description: 对经 Schema 验证的 DEAL 追加 Ed25519 签名。只接受 deal + expected_body_hash 两个参数：先按 deal.schema.json 验证 body、重算 body_hash 并与 expected_body_hash 比对，一致才签；无任意字节签名接口、无人工确认、受本地预算策略约束。返回简短摘要 + object_id。
---

# trade-sign-deal

## 用途

为 DEAL 追加本方 Ed25519 签名（RFC 8032）。多方签同一不变对象：**增签不破旧签**，审签方与起草方使用同一文件。

## 签名红线（工具级约束，必须落实）

1. **只签经 Schema 验证的 DEAL**：先按 `deal.schema.json`（2020-12）验证 `body`；重算 `actual = "sha256:" + lowerhex(SHA-256(utf8(JCS(body))))`，与 `expected_body_hash` 不一致**拒绝并返回原因**。只执行验签而跳过 body 重算等于没有验证（"改 body 不改 hash"攻击，见 `protocol/test-vectors/files/deal-tampered-body-keep-hash.json`）。
2. **必须传 `expected_body_hash`**：本工具不接受"文件里声明的 body_hash"作为签署依据；调用方另行计算并传入期望哈希，工具独立重算比对。
3. **无任意字节签名接口**：只接受 DEAL 对象；不提供签任意字符串/任意文件的通用接口；`object_type` 必须为 `DEAL` 且 `protocol === "agent-trade/0.2"`。
4. **无人工确认**：签约决策由调用方模型做出；本工具不弹人工确认环节。
5. **预算策略**：签前检查本地策略（如 `policy.json` 的 `max_amount_per_deal` / `max_consideration`）；超限拒绝并返回原因。私钥只读本机 `.data/keys/`，不出进程。

## 参数

| 参数 | 说明 |
| --- | --- |
| `deal` | 完整 DEAL 对象（body 可为无签名或已有对方签名） |
| `expected_body_hash` | 调用方另行计算并传入的期望 `body_hash`（`sha256:<hex>`），工具独立重算比对 |

## 内部步骤

1. 校验 `deal` 的 `protocol` / `object_type` 与信封结构；校验 `body` 符合 deal.schema.json。
2. 重算 `actual = sha256(JCS(body))`；若文件已声明 `body_hash`，`actual` 必须同时等于它和 `expected_body_hash`，否则拒绝。
3. 检查预算策略（`max_amount_per_deal` 等），超限拒绝。
4. 构造 `signing_input = utf8(protocol) ‖ 0x00 ‖ utf8("DEAL") ‖ 0x00 ‖ utf8(body_hash)`；Ed25519 签名（RFC 8032，64 字节 raw → base64url 无填充，86 字符）。
5. 追加 `signatures[]`：`{ signer, algorithm: "Ed25519", signature, issued_at: <RFC3339> }`。

## 返回

简短摘要 + `object_id`（+ 本签 `signer` / `issued_at`）。**不返回完整 DEAL 全文**。

## 注意事项

- 审签方在签前可用 `trade_verify_deal` 先验（或依赖本工具的 ①② 步）；签署后双方应各 `trade_verify_deal` 一次。
- 增签不改 body、不改既有签名；`body_hash` 与 `object_id` 在增签前后不变。
- 拒绝必须返回原因（如 hash 不一致 / Schema 失败 / 超预算），不得静默。
- 注册细节待运行时探测：见 `integrations/deepseek-harness/INSPECTION.md` 第二部分。
