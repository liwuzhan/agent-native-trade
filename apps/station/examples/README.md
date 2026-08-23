# S5 三角色互演 demo + 部署文档

本目录交付两样东西：

1. **一键演示** `bash station-demo.sh` —— 从干净状态跑通「发布站 → 整合商 → 索引站」全链路，
   并逐步断言（验签、标签命中、评分非零、离线快照、镜像可用）。
2. **5 分钟起一个站** —— 三角色（publisher / integrator / indexer）各自的最小 yaml、
   启动命令、curl 验证与常见问题，零基础用户照着做即可起任意一个站。

> 所有演示数据均为虚构，身份使用 `protocol/test-vectors/vectors.json` 的
> `agent_buyer` / `agent_seller` 种子（仅测试向量，禁止用于生产）。

---

## 0. 目录结构

```text
examples/
├── station-demo.sh        # 干净状态一键演示（构建 → demo → 断言）
├── demo.mjs               # 演示编排（起三角色进程 + 全链路 + 签名 + 快照 + 离线查询）
├── assertions.mjs         # 逐步断言
├── README.md              # 本文件
└── configs/               # 演示用三份 yaml（station-demo.sh 直接使用）
    ├── indexer.yaml
    ├── publisher.yaml
    └── integrator.yaml
```

---

## 1. 一键演示

```bash
cd apps/station/examples
bash station-demo.sh
```

脚本会依次：`npx tsc -b` 构建 → 清理 `runlog/` → `node demo.mjs`（演示）→
`node assertions.mjs`（断言）。最后一行 `🎉 全部断言通过` 即验收通过。

演示链路（每步 30s 硬超时；BT 播种/下载 20s 超时 + 镜像降级，借鉴 M11 的
`withTimeout` 模式）：

```text
publisher 发布虚构"家电维修"服务目录（catalog.json 带 metadata.tags: ["朝阳","家电维修"]）
  → integrator 合成"北京家电维修专题"（member = 发布站 LISTING_REF）
  → indexer 通过轻量通告收录（公钥 + LISTING_REF + catalog card；完整 PUT 镜像仅作演示缓存）
  → GET /catalogs?tag=朝阳&tag=家电维修 命中发布站目录
  → 买方从 indexer 镜像下载目录
  → 用 @agent-trade/signed-files + 测试向量身份签 DEAL + 双方回执
  → 回执 POST indexer → GET /export 快照
  → 杀 indexer 进程 → demo-indexer CLI 离线查询验证快照（verified=valid）
  → 重启 indexer → 杀 publisher 进程 → indexer 镜像仍可供目录
```

产物（每次从干净状态重建，已 gitignore）：

- `runlog/demo-summary.json` —— 每步 object_id / catalog_hash / 评分 / 文件路径全量摘要
- `runlog/artifacts/` —— 各签名文件（LISTING_REF / 目录存档 / DEAL / 回执）
- `runlog/export/indexer.json` + `.sig` —— 索引站离线快照 + 分离签名
- `runlog/<role>.log` —— 三个角色的运行日志

---

## 2. 五分钟起一个站（三角色）

统一前提（做一次即可）：

```bash
cd apps/station
npx tsc -b            # 构建 dist/cli.js
```

然后 `node dist/cli.js <indexer|publisher|integrator> --config <yaml>` 启动，
`Ctrl-C`（SIGINT）优雅退出。以下每个角色的「最小 yaml」都以 `apps/station/`
为工作目录编写；`data_dir` 是 `.data/` 的**父目录**（不是 `.data/` 本身），
单站演示写 `data_dir: .` 即可。

### 2.1 发布站 publisher

**最小 yaml**（保存为 `my-publisher.yaml`）：

```yaml
agent_id: my-publisher
identity_seed_file: .publisher.seed     # 首次启动自动生成（32 字节，0600）
data_dir: .                             # .data/ 的父目录
http: { host: 127.0.0.1, port: 8788 }
log: { level: info }
role: publisher
publisher:
  catalog_dir: ./my-catalog             # 目录内必须有 catalog.json
  trackers: []                          # 单机演示无外部 tracker
  announce_to: []                       # 演示可不通告索引站
  watch: false
  dht: false                            # 关闭 DHT，避免挂起
  # public_base_url: https://catalog.example.com  # 对外部署时填写
```

先准备一份目录（`catalog.json` 至少要有 `catalog_id` / `item_id`）：

```bash
mkdir -p my-catalog
cat > my-catalog/catalog.json <<'EOF'
{
  "catalog_id": "demo-catalog",
  "item_id": "demo-item",
  "item_revision": 0,
  "metadata": { "tags": ["示例", "标签"] }
}
EOF
```

**启动**：

```bash
node dist/cli.js publisher --config my-publisher.yaml
```

**验证（curl）**：

```bash
curl -s http://127.0.0.1:8788/healthz
# {"ok":true,"role":"publisher","agentId":"my-publisher"}

curl -s http://127.0.0.1:8788/listing-ref   # 已签 LISTING_REF（JCS JSON）
```

**常见问题**：

- `publisher.catalog_dir: missing catalog.json at the directory root`
  —— `catalog_dir` 目录根缺 `catalog.json`（或不是合法 JSON）。
- 端口被占：改 `http.port`（或 `STATION_HTTP_PORT` 环境变量覆盖）。
- `data_dir` 写成了 `.data/` 本身 —— 应写 `.data/` 的父目录（如 `.`）。

### 2.2 整合商 integrator

**最小 yaml**（保存为 `my-integrator.yaml`）：

```yaml
agent_id: my-integrator
identity_seed_file: .integrator.seed
data_dir: .
http: { host: 127.0.0.1, port: 8789 }
log: { level: info }
role: integrator
integrator:
  theme: 示例专题
  tags: [示例, 标签]
  members: []                # 可为空；也可填 LISTING_REF 文件路径或 http(s) URL
  reseed: false
  announce_to: []
  trackers: []
  dht: false
```

**启动**：

```bash
node dist/cli.js integrator --config my-integrator.yaml
```

**验证（curl）**：

```bash
curl -s http://127.0.0.1:8789/healthz
# {"ok":true,"role":"integrator","agentId":"my-integrator"}

curl -s http://127.0.0.1:8789/catalog       # 合成专题目录（M8 存档包）
curl -s http://127.0.0.1:8789/listing-ref  # 专题 LISTING_REF
curl -s -X POST http://127.0.0.1:8789/refresh   # 手动重新合成
```

**常见问题**：

- `members` 指向某发布站的 `http://.../listing-ref` 却被拒绝（`member rejected` /
  `verify: fail:unknown_signer`）—— 整合商需要先知道成员公钥。把发布站公钥写到
  `.data/peers/<agentId>.pub`（43 字符 base64url 公钥一行）。不要导入对方私钥；
  `.data/keys/` 只保存本站自己的身份种子。
- `members` 留空也可启动（合成 0 成员的专题目录），只是没有聚合内容。

### 2.3 索引站 indexer

**最小 yaml**（保存为 `my-indexer.yaml`）：

```yaml
agent_id: my-indexer
identity_seed_file: .indexer.seed
data_dir: .
http: { host: 127.0.0.1, port: 8787 }
log: { level: info }
role: indexer
indexer:
  weights_file: ../demo-indexer/weights.json   # 评分规则（M8）
```

**启动**：

```bash
node dist/cli.js indexer --config my-indexer.yaml
```

**验证（curl）**：

```bash
curl -s http://127.0.0.1:8787/healthz
# {"ok":true,"role":"indexer","agentId":"my-indexer"}

curl -s http://127.0.0.1:8787/                 # 只读状态页（HTML）

# 通告一份完整 transport announcement（公钥 + LISTING_REF + catalog card）
curl -s -X POST http://127.0.0.1:8787/announce/listing-ref \
  -H 'content-type: application/json' --data-binary @some-listing-ref.json

# 可选：镜像一份完整目录存档包（PUT /catalogs/:hash，返回 201）
curl -s -X PUT http://127.0.0.1:8787/catalogs/sha256:<64hex> \
  -H 'content-type: application/json' --data-binary @catalog-archive.json

# 标签检索（AND 语义）
curl -s 'http://127.0.0.1:8787/catalogs?tag=示例&tag=标签'

# 快照导出（离线可验签）
curl -s http://127.0.0.1:8787/export
```

**常见问题**：

- `indexer.weights_file: expected a non-empty string path` —— `weights_file` 路径
  不存在或为空；相对路径相对**进程工作目录**解析。
- 陌生身份发送裸 LISTING_REF 返回 `fail:unknown_signer` —— 让 publisher 按
  `announce_to` 发送完整通告；完整通告会验签并自动保存公钥（TOFU）。
- 标签检索查不到 —— 检查完整通告是否成功，以及 `catalog.json.metadata.tags`；
  完整目录 PUT 不是检索前置条件。

---

## 3. 演示数据与身份（全部虚构）

- 发布站目录：`runlog/publisher-catalog/catalog.json`（`家电维修` 服务，虚构）。
- 整合商专题：`北京家电维修专题`（tags `北京+家电维修`），member 为发布站 LISTING_REF。
- 交易身份：`agent_buyer` / `agent_seller` 种子取自 `protocol/test-vectors/vectors.json`
  （测试向量，非真实秘密）；`agent_integrator` / `agent_indexer` 每次运行生成全新站点身份，
  仅保存在 gitignored 的 `runlog/identity/`。
- 交易内容（DEAL 金额、地址、承运方、回执评语等）均为虚构。

---

## 4. 与模块卡片的一致性说明

- 卡片演示链路写的是「棉花娃娃 / 春季专题」，本实现按任务实现要点改为
  「家电维修 / 北京家电维修专题」（tags `朝阳+家电维修` → 城市级 `北京+家电维修`），
  其余步骤（轻量通告 + 可选 PUT 镜像、标签命中、签 DEAL + 双回执、快照导出、离线查询、
  杀 publisher 后镜像仍可供目录）与卡片一致。
- 卡片边界「不做 docker 镜像实测」「不写生产部署（systemd/nginx）」——本目录只交付
  开发/演示形态。
