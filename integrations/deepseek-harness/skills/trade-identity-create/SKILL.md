---
name: trade-identity-create
description: 生成新 Ed25519 身份并把私钥以 0600 权限落盘到 .data/keys/。返回 agentId + 公钥，绝不返回私钥；私钥只读本机、不出进程。
---

# trade-identity-create

## 用途

为本地 agent 生成协议身份（Ed25519，RFC 8032）。agentId 全局唯一即可；默认生成 `agent_<hex>`。

## 参数

| 参数 | 说明 |
| --- | --- |
| `agentId` | 可选，指定身份 id；已存在则拒绝 |

## 返回

简短摘要 + `object_id`（`identity:<agentId>` 形式，非 sha256 对象）：`{agentId, publicKey}`。

## 红线

- 私钥只落本机 `.data/keys/`（0600），任何工具都不返回私钥、不接受调用方提供的私钥。
- 对端公钥通过 `.data/peers/<agentId>.pub` 导入信任环（只读公钥文件，43 字符 base64url）。
