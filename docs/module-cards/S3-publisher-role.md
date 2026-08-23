# 模块卡片：S3 publisher 角色

- **目标**：实现发布站薄编排：目录 → canonical manifest → 签 LISTING_REF → BT 常驻做种 + HTTP 兜底 → 通告索引站。
- **输入**：S1（配置/身份/HTTP 基座）、M1/M2/M3/M4；S1 通告契约。

## 输出

`apps/station/src/roles/publisher/`：

```text
POST /announce/listing-ref  # 自己也提供，返回本机已发布引用
GET  /healthz
GET  /catalogs/:hash        # HTTP 兜底下载（按 catalog_hash）
GET  /listing-ref            # 当前签名 LISTING_REF
POST /announce               # 重发完整通告
station publisher --config publisher.yaml
```

配置：`publisher.catalog_dir`、`trackers[]`（可空/DHT）、`announce_to[]`（索引站 URL）、`watch`（默认 false）、`public_base_url`（对外广播地址，可选）。

行为：

1. 读取目录文件，调用 M4 `buildManifest/catalogHash`；
2. 构造并签名 LISTING_REF（publisher/catalog_id/item_id/catalog_hash/distribution_refs；tags 不进入协议对象）；
3. `seed()` 常驻做种，保留 magnet + torrentFile；同时提供 HTTP 目录包；
4. 对每个 `announce_to` POST `/announce/listing-ref`，发送公钥 + LISTING_REF + 轻量 catalog card，带超时和有限重试；
5. 目录变更时重新 hash/签名/做种（旧引用保留，不能原地修改）。

依赖：S1、M1/M2/M4；dev：vitest。

## 验收指标（即测试）

1. 最小目录启动成功，LISTING_REF `verifyFile === 'valid'`，`catalog_hash` 与 manifest 一致。
2. 本地 tracker 下 seed→download 往返成功；进程杀掉后索引站镜像仍能 GET 目录。
3. 内容改动 → 新 catalog_hash、新 object_id；旧签名文件不被覆盖。
4. 通告到测试 indexer：无需复制种子或 PUT 完整目录即可收录检索；索引站停机只记录重试失败，不阻塞做种。
5. `GET /healthz`/`/listing-ref`/`/catalogs/:hash` 正常；`vitest run` 与 `tsc -b` 全绿。

## 边界

- 不做商品编辑 UI、账号、支付、TLS、反垃圾；不自动删旧目录。
