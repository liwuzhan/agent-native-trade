# 通告契约（Announce Contract）

> 本契约由模块卡片 S1 定死，S2–S4 必须共同遵守。本文档是 `@agent-trade/station`
> 通告契约的唯一权威副本，任何实现以本文为准。

## POST /announce/listing-ref

```text
POST /announce/listing-ref
  Content-Type: application/json
  Body: 完整 LISTING_REF 签名信封（M2 SignedFile JSON）
  → 200 { "status": "accepted", "object_id": "sha256:..." }       # 验签通过且收录
  → 400 { "error": "<reason>", "verify_result": "fail:..." }      # 验签/schema 失败
  → 409 { "error": "conflict", "object_id": "..." }               # 同 object_id 异内容
```

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
- S1 仅交付 stub 角色，实现 `GET /healthz`；`POST /announce/listing-ref` 由
  S2（indexer 角色）实现，S3/S4 复用同一契约。
