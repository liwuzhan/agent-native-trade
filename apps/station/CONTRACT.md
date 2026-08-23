# 通告契约（Announce Contract）

> 本契约由模块卡片 S1 定死，S2–S4 必须共同遵守。本文档是 `@agent-trade/station`
> 通告契约的唯一权威副本，任何实现以本文为准。

## POST /announce/listing-ref

```text
POST /announce/listing-ref
  Content-Type: application/json
  Body: ListingAnnouncement（见下；推荐）或已知 signer 的裸 LISTING_REF（兼容）
  → 200 { "status": "accepted", "object_id": "sha256:..." }       # 验签通过且收录
  → 400 { "error": "<reason>", "verify_result": "fail:..." }      # 验签/schema 失败
  → 409 { "error": "conflict", "object_id": "..." }               # 同 object_id 异内容
```

推荐的 `ListingAnnouncement` 是传输层 wrapper，不是第五种签名协议对象：

```json
{
  "identity": {"agent_id": "publisher-id", "public_key": "<Ed25519 base64url>"},
  "listing_ref": {"object_type": "LISTING_REF", "...": "原样签名信封"},
  "catalog": {
    "manifest": {"files": [{"path": "catalog/catalog.json", "sha256": "<64hex>"}]},
    "catalog_json": {"path": "catalog/catalog.json", "content": "<base64>"}
  }
}
```

接收顺序：用随附公钥验证 LISTING_REF → 校验 `agent_id == body.publisher` →
重算 manifest 的 `catalog_hash` → 校验 catalog.json 文件 hash → 按 agent_id
建立公钥 TOFU 映射 → 收录。只持久化公钥和轻量目录卡片，不持久化对方私钥，
也不要求完整目录先 `PUT` 到 indexer。

## GET /healthz

```text
GET /healthz → 200 { "ok": true, "role": "<role>", "agentId": "..." }
```

## 说明

- `object_id` 为 M2 定义的 `"sha256:" + lowerhex(SHA-256(signing_input))`。
- `verify_result` 取值与 `@agent-trade/signed-files` 的 `VerifyResult` 一致
  （`fail:body_hash_mismatch` / `fail:object_id_mismatch` / `fail:schema_invalid` /
  `fail:unknown_signer` / `fail:signature_invalid` / `fail:protocol_version`）。
- `409 conflict` 表示同一 `object_id` 已被收录但内容不同（异内容冲突）；同一
  `object_id` 相同内容重复投递应幂等返回 `200`。
- `409 identity_conflict` 表示该 `agent_id` 已经绑定另一个公钥；不得静默换钥。
- 裸 LISTING_REF 保留给已预置信任的旧客户端。陌生身份应发送完整 wrapper，
  否则返回 `fail:unknown_signer`。
- S1 仅交付 stub 角色，实现 `GET /healthz`；`POST /announce/listing-ref` 由
  S2（indexer 角色）实现，S3/S4 复用同一契约。
