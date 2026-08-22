# 模块卡片：M4 bt-catalog

- **目标**：实现 `@agent-trade/bt-catalog` 包——canonical manifest 的生成/校验 + WebTorrent 做种/下载 + 确定性测试用本地 tracker。
- **输入**：`protocol/specification.md` §4（LISTING_REF 与 manifest 规则）；`@agent-trade/identity`（sha256Hex、jcs）。

## 输出

`packages/bt-catalog/`，ESM + TS strict：

```ts
export interface ManifestFile { path: string; sha256: string }   // 小写 hex，无前缀
export interface Manifest { files: ManifestFile[] }
export function buildManifest(files: { path: string; data: Uint8Array }[]): Manifest  // 自动按规则排序
export function catalogHash(manifest: Manifest): string          // "sha256:" + hex(JCS(manifest))
export function verifyCatalogFiles(files: { path: string; data: Uint8Array }[], manifest: Manifest): boolean
export function seed(dir: string, opts?: { tracker?: string[] }): Promise<{ infoHash: string; magnetURI: string; torrentFile: Uint8Array; stop(): Promise<void> }>
export function download(magnetURI: string, destDir: string, opts?: { tracker?: string[] }): Promise<Manifest>
export function startTracker(port?: number): Promise<{ port: number; close(): Promise<void> }>  // 仅测试
```

canonical manifest 规则（specification §4，必须写死并有单测）：

- 路径：UTF-8、正斜杠、相对路径；拒绝 `..`、前导 `/`、反斜杠、空段；
- `files` 按 path 的**字节序**字典序排序；重复 path 报错；
- 每文件 sha256 = 小写 hex；`catalogHash` 对整个 manifest 做 JCS 后哈希。

依赖：`webtorrent`（Node 版自带 DHT/LSD/PEX）；dev：`bittorrent-tracker`、`vitest`。**不引入 create-torrent / magnet-uri**，除非确认 webtorrent API 不足并登记原因。

## 验收指标（即测试）

1. canonical 规则单测：同内容不同文件添加顺序 → 同一 `catalogHash`；非法路径逐一拒绝；排序用例（`a/b.json` vs `a-b.json` 字节序）。
2. **本地 tracker 往返**：`startTracker` + `seed(dirA, {tracker})` → `download(magnet, dirB, {tracker})`（DHT 关闭）→ `verifyCatalogFiles` 通过、hash 相等。
3. 损坏检测：下载后改动目标文件一个字节 → `verifyCatalogFiles` 返回 false。
4. **DHT 验收（手动，不进 CI）**：提供 `scripts/dht-acceptance.mjs`——禁 tracker、不预配置内容 peer，卖方做种并等待 DHT 宣告，买方仅凭 magnet 下载；脚本打印每步状态，由 K3 在真实网络执行记录。
5. `vitest run` 全绿；`tsc -b` 无错误。

## 边界

- 不自实现 DHT/Tracker 协议；不做目录 SEO/排序/垃圾过滤；不做 HTTP 镜像（M8 职责）。
- webtorrent 的原生依赖问题若出现，登记 FUTURE 并用最小 workaround。
