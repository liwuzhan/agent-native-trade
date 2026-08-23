# 模块卡片：S1 station 骨架 + 配置 + CLI

- **目标**：实现 `@agent-trade/station` 骨架——配置加载、CLI 角色分发、共享 daemon 基座、**三角色通告契约（本卡定死，S2–S4 遵守）**。
- **输入**：已交付 M1–M4；模板站技术选型 V0.1。

## 输出

`apps/station/`：

```ts
export interface StationContext {
  agentId: string; publicKey: string; secretKey: string
  config: StationConfig; dataDir: string
  store: Store                                  // M3 openStore(dataDir)
  logger: (level: 'info'|'warn'|'error', msg: string, extra?: object) => void
}
export interface StationRole { name: string; start(ctx: StationContext): Promise<{ stop(): Promise<void> }> }
export function loadConfig(path: string): StationConfig          // YAML/JSON + env 覆盖 + 校验（错误带字段名）
export function runStation(roleRegistry: Record<string, StationRole>, argv: string[]): Promise<void>
```

- CLI：`station <role> --config <path>`；`<role>` ∈ indexer|publisher|integrator；S1 交付时 registry 可空（S2–S4 注册）。
- 身份：`identity_seed_file` 指向 32 字节 seed 文件（0600）；不存在则生成并写入。
- 数据目录：`<data_dir>/` 下走 M3 `.data/` 布局；`log` 打到 stdout（JSON 行）。

**基础配置 schema**（role 块各角色自定，基座只透传）：

```yaml
agent_id: station-indexer-01
identity_seed_file: ./seed.key
data_dir: .data
http: { host: 0.0.0.0, port: 8780 }
log: { level: info }
role: indexer | publisher | integrator
indexer:    { weights_file, mirror_catalogs: true }
publisher:  { catalog_dir, trackers: [], announce_to: [] }
integrator: { theme, tags: [], members: [], reseed: false }
```

## 通告契约（S2–S4 必须共同遵守，写死）

```text
POST /announce/listing-ref
  Content-Type: application/json
  Body: ListingAnnouncement（公开身份 + LISTING_REF + 轻量 catalog card）；
        已知 signer 的裸 LISTING_REF 仅作兼容
  → 200 { "status": "accepted", "object_id": "sha256:..." }       # 验签通过且收录
  → 400 { "error": "<reason>", "verify_result": "fail:..." }      # 验签/schema 失败
  → 409 { "error": "conflict", "object_id": "..." }               # 同 object_id 异内容
GET /healthz → 200 { "ok": true, "role": "<role>", "agentId": "..." }
```

依赖：`yaml`、内部四包（file:）；dev：vitest、typescript@5.9.3、@types/node。

## 验收指标（即测试）

1. 最小 config 启动三个 stub 角色成功；`--config` 缺文件/字段非法 → 报错含字段名。
2. `identity_seed_file` 不存在则生成、权限 0600；再次启动复用同一身份。
3. env 覆盖正确（如 `STATION_HTTP_PORT=9000` 覆盖 yaml 的 http.port）。
4. 数据目录隔离：两个不同 data_dir 的实例互不干扰。
5. `vitest run` 全绿；`tsc -b` 零错误。

## 边界

- 不做角色实现（S2–S4）；不做 TLS/鉴权（内网/玩票阶段，登记 FUTURE）；不做 npm 发布。
- 只准在 apps/station/ 内工作；取舍写报告。
