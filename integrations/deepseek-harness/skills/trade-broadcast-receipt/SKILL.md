---
name: trade-broadcast-receipt
description: 把已签 TRADE_RECEIPT 提交到配置的 HTTP indexer，并同时打包为 bt-catalog 证据包。默认 indexer 是 https://deepcrop.site，可由 AGENT_TRADE_INDEXERS 或本次调用覆盖；各站独立决定签名者信任与评价权重。
---

# trade-broadcast-receipt

## 用途

把回执提交给公开索引站，并生成可验证的 BT bundle 作为并行证据分发。HTTP 提交失败或 `unknown_signer` 必须如实返回，不能把本地做种声称为公开收录。

## 参数

| 参数 | 说明 |
| --- | --- |
| `receipt` | 已签 TRADE_RECEIPT 信封；与 `object_id` 二选一 |
| `object_id` | 已存储回执的 object_id；与 `receipt` 二选一 |
| `signer` | 可选，本地私钥增签（多签不破旧签） |
| `indexer_urls` | 可选，本次广播使用的 HTTP(S) indexer 基址数组；替换默认配置 |

## 内部步骤

1. 解析/验证回执信封（必须是 TRADE_RECEIPT）。
2. 可选增签 → 落库（putObject 内部四步验签）。
3. 写 `<dir>/.data/bundles/<object_id>/receipt.json` + `manifest.json`（buildManifest，路径按字节序排序）。
4. 向 indexer 的 `POST /receipts` 提交已签回执，记录每个站的 HTTP 状态。
5. `seed()`（dht:false；`localTracker` 配置时带本地 announce URL）→ 返回 magnet。

## 返回

简短摘要 + `object_id`：`{magnet_uri, tracker?, a:[{u,s,ok}], bundle_files, status}`；`a` 分别表示 indexer URL、HTTP 状态和是否接受。

## 注意

- 同 id 重复广播会停旧种、起新种（daemon 生命周期内）。
- 无 tracker 时 magnet 需 DHT/手动传输才能被取走；这不影响 HTTP indexer 已接受的回执，但不能替代完整证据包交付。
