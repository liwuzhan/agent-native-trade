# 模块卡片：M2 signed-files

- **目标**：实现 `@agent-trade/signed-files` 包——统一签名信封的构建、签署、序列化与**强制四步验签**。四个协议对象的读写层。
- **输入**：`protocol/specification.md`（§1–§4 全部）；`protocol/schemas/*.json`；`protocol/test-vectors/vectors.json`；M1 的 `@agent-trade/identity`（接口见 `docs/module-cards/M1-identity.md`，只依赖其导出函数签名，不依赖内部实现）。

## 输出

`packages/signed-files/`，ESM + TypeScript strict，`tsc -b` 产出。导出接口：

```ts
export type ObjectType = 'LISTING_REF' | 'DEAL' | 'TRADE_EVENT' | 'TRADE_RECEIPT'
export interface SignedFile { protocol: string; object_type: ObjectType; body: unknown; body_hash: string; signatures: Signature[] }
export type VerifyResult = 'valid' | 'fail:body_hash_mismatch' | 'fail:object_id_mismatch' | 'fail:schema_invalid' | 'fail:unknown_signer' | 'fail:signature_invalid' | 'fail:protocol_version'

export function buildObject(objectType: ObjectType, body: unknown): SignedFile          // 算 body_hash；signatures=[]
export function objectId(file: SignedFile): string                                       // 按规范 §2 派生
export function addSignature(file: SignedFile, signer: string, secretKey: string, issuedAt?: string): SignedFile  // 追加，不破坏已有签名
export function verifyFile(file: SignedFile, resolveKey: (signer: string) => string | undefined): VerifyResult   // 完整四步，见下
export function serialize(file: SignedFile): string                                      // 存储/传输用（JCS）
export function parse(text: string): SignedFile```

`verifyFile` 必须严格按 specification.md §3 顺序执行：

```text
0. protocol === 'agent-trade/0.2'，否则 fail:protocol_version
① 重算 sha256(JCS(body)) 与声明 body_hash 比对 → fail:body_hash_mismatch
② 重算 object_id（若文件带 object_id 声明则比对）
③ body 过对应 object_type 的 JSON Schema（ajv 2020-12 + ajv-formats）→ fail:schema_invalid
④ 逐条验签：resolveKey(signer) 取公钥（取不到 → fail:unknown_signer），严格模式验签 → fail:signature_invalid
全部通过 → 'valid'
```

依赖：`@agent-trade/identity`（M1）、`ajv` + `ajv-formats`；dev：`vitest`。

## 验收指标（即测试，先写后实现）

1. `vectors.json` 全部 6 用例经过完整 `verifyFile`（含 schema 步）后，结果与 `expect` 逐一相等。
2. **多签独立性**：`deal-valid` 移除任一签名后，剩余签名仍 `valid`。
3. **错误验签器对照测试**：在测试里写一个故意跳过步骤①的 naiveVerify，证明它**接受** `deal-tampered-body-keep-hash` 而 `verifyFile` **拒绝**——防回归。
4. **schema 拒绝**：把 `deal-valid` 的 `body.settlement` 删掉后对原 body_hash 重新签名（测试内自签），`verifyFile` 必须返回 `fail:schema_invalid`（签名真、结构假）。
5. **跨类型重放防护**：把 `listing-ref-valid` 的签名原样贴到一个 body 相同的 DEAL 上，`verifyFile` 必须返回 `fail:signature_invalid`（类型前缀生效）。
6. 序列化往返：`buildObject → addSignature ×2 → serialize → parse → verifyFile === 'valid'`，且两次 `serialize` 输出逐字节相等。
7. `vitest run` 全绿；`tsc -b` 无错误。

## 边界

- 不做：本地存储/索引（M3）、密钥文件管理（M3 `.data/keys/`）、网络 IO。
- schema 加载：`protocol/schemas/*.json` 在构建期复制进包内（`src/schemas/`），运行时读包内副本，不依赖仓库相对路径。
- 取舍登记到 `FUTURE.md`。

## 参考

- 技术选型 V0.4 §6.2/§6.3（信封与验签算法）、§16（联动修订）。
- M0 验收记录：`protocol/test-vectors/README.md`。
