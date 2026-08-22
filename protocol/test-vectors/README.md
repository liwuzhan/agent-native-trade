# 测试向量（协议权威源）

`vectors.json` 是唯一权威文件；其余为衍生材料。

## 结构

- `vectors.json` — 身份（公钥 + 仅测试用种子）、6 个用例（信封文件 + 期望结果）
- `files/<case>.json` — 每个用例的独立信封文件（可直接喂给实现）
- `openssl/` — OpenSSL 交叉验签材料（`.pem` 公钥 / `.sig` 原始签名 / `.input.bin` 签名输入）

## 用例

| 用例 | 期望 | 针对的实现错误 |
|---|---|---|
| listing-ref-valid | valid | — |
| deal-valid | valid | 双签叠加（后签不破先签） |
| trade-event-valid | valid | — |
| trade-receipt-valid | valid | 含 evidence 可验证引用 |
| deal-tampered-body-keep-hash | fail:body_hash_mismatch | **专杀跳过重算 body_hash 的验签器** |
| deal-tampered-body-rehash | fail:signature_invalid | 重算 hash 后签名输入失配 |

## 再生成与验证

```bash
node tools/generate-test-vectors.mjs   # 再生成（会换密钥，object_id 随之变化）
node tools/verify-test-vectors.mjs     # 参考验签器（node:crypto）
bash tools/verify-vectors-openssl.sh   # OpenSSL 交叉验签
```
