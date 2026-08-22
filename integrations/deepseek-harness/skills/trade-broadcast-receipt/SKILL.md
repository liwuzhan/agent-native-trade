---
name: trade-broadcast-receipt
description: 把已签 TRADE_RECEIPT 打包为证据包（receipt.json + canonical manifest）并用 bt-catalog 做种（dht 关闭，可带本地 tracker）。返回回执 object_id + magnet URI；下载侧接线留给 M8（FUTURE）。
---

# trade-broadcast-receipt

## 用途

公开证据包档次的披露：生成可验证的 bundle 并把 magnet 交给对方（可经 `trade_contact_seller` 邮件传递）。单文件 bundle 确定性可验（canonical manifest 规则同 M4）。

## 参数

| 参数 | 说明 |
| --- | --- |
| `receipt` | 已签 TRADE_RECEIPT 信封；与 `object_id` 二选一 |
| `object_id` | 已存储回执的 object_id；与 `receipt` 二选一 |
| `signer` | 可选，本地私钥增签（多签不破旧签） |

## 内部步骤

1. 解析/验证回执信封（必须是 TRADE_RECEIPT）。
2. 可选增签 → 落库（putObject 内部四步验签）。
3. 写 `<dir>/.data/bundles/<object_id>/receipt.json` + `manifest.json`（buildManifest，路径按字节序排序）。
4. `seed()`（dht:false；`localTracker` 配置时带 `http://127.0.0.1:<port>/announce`）→ 返回 magnet。

## 返回

简短摘要 + `object_id`：`{magnet_uri, tracker?, bundle_files, status: 'seeded'}`。

## 注意

- 同 id 重复广播会停旧种、起新种（daemon 生命周期内）。
- 无 tracker 时 magnet 需 DHT/手动传输才能被取走；本环境 DHT 受限（见 RELEASE.md 登记），演示用邮件传递 magnet。
