# 模块卡片：M1 identity

- **目标**：实现 `@agent-trade/identity` 包——Ed25519 密钥、签名/验签（严格 RFC 8032）、SHA-256、JCS 规范化。全项目的密码学地基。
- **输入**：`protocol/test-vectors/vectors.json`（权威源）；`protocol/specification.md` §1/§2；`tools/generate-test-vectors.mjs` 中的参考 JCS 实现（可对照，不可照抄了事——要用 `@noble/hashes` 与 `@noble/ed25519` 重新实现）。

## 输出

`packages/identity/`，ESM + TypeScript strict，`tsup`/`tsdown` 均不需要，直接 `tsc -b` 产出。导出接口：

```ts
export interface Identity { publicKey: string; secretKey: string } // base64url，43 字符
export function generateIdentity(): Identity
export function sign(message: Uint8Array, secretKey: string): string      // base64url，86 字符
export function verify(message: Uint8Array, signature: string, publicKey: string): boolean
export function sha256Hex(input: string | Uint8Array): string             // 小写 hex，无前缀
export function jcs(value: unknown): string                               // RFC 8785
export function publicKeyFromSeed(seed: string): string                   // base64url → base64url
```

- `verify` 必须严格 RFC 8032：`@noble/ed25519` 调用显式 `zip215: false`。
- 依赖：仅 `@noble/ed25519` + `@noble/hashes`。dev 依赖：`vitest`、`canonicalize`（交叉对照用）。

## 验收指标（即测试，先写后实现）

1. 读取 `protocol/test-vectors/vectors.json`：`verify` 对全部 `expect=valid` 用例返回 true，对 `deal-tampered-body-rehash` 返回 false。
2. 对 `vectors.json` 全部用例的 `body` 重算：`"sha256:" + sha256Hex(jcs(body))` === 文件声明的 `body_hash`。
3. **JCS 交叉对照**：`jcs` 与 npm 包 `canonicalize` 在 ≥50 个样本上输出完全一致——样本必须覆盖：深层嵌套、中文/emoji、键序打乱、整数、`0`、负数、`true/false/null`、空对象/空数组、含控制字符与引号的字符串。
4. 随机生成 100 个身份：sign→verify 往返全过；公钥可从种子稳定导出（`publicKeyFromSeed` 幂等）。
5. **严格性**：把有效签名做 S+L 可塑性变形（S 加上群阶 L 后 base64url），`verify` 必须返回 false（证明 zip215:false 生效）。
6. `vitest run` 全绿；`tsc -b` 无错误。

## 边界

- 不做：密钥存储/权限管理（M3 的 `.data/keys/`）、信封组装（M2）、uuid。
- 不做任何网络/文件 IO；纯函数库。
- 取舍登记：如 noble 与 node:crypto 行为差异，记录到 `FUTURE.md`。

## 参考

- 技术选型 V0.4 §6.1（算法与编码约定、zip215:false 的原因）。
- RFC 8032（Ed25519）、RFC 8785（JCS）。
