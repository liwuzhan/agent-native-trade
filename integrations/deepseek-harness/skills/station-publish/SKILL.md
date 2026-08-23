---
name: station-publish
description: 用 station 的 publisher 角色发布商品目录并自动通告 indexer。通告携带公钥、签名 LISTING_REF 与轻量 catalog card；无需复制私钥或镜像完整目录即可按标签检索。完整 PUT 镜像仅是可选缓存。
---

# station-publish

## 用途

用 station 的 publisher 角色「发布一个商品」，最终让 indexer 能按标签检索到它。发布站会在一次通告里发送：自身公钥、签名 LISTING_REF、manifest 和哈希保护的 `catalog.json`。indexer 验签后按首次见到的公钥建立身份映射（TOFU），不接触发布者私钥，也不需要保存完整目录。

## 前置

1. Node ≥ 24，且 station 已构建（生成 `dist/cli.js`）：

   ```bash
   cd apps/station
   npx tsc -b
   ```

2. 一个**运行中的 indexer**，记其基址为 `INDEXER`（示例 `http://127.0.0.1:8787`）。可用 `curl -s $INDEXER/healthz` 确认，期望 `{"ok":true,"role":"indexer","agentId":"..."}`。没有现成 indexer 时见文末「附：快速起一个 indexer」。

3. 不需要向 indexer 预置发布站种子。首次通告会自动引导公钥；同一 `agent_id` 后续若换成不同公钥会被拒绝。

## 步骤

以下命令默认以 `apps/station/` 为工作目录；相对路径都相对该目录解析。

### 1. 准备目录 JSON

发布站读一个**目录目录**（`publisher.catalog_dir`），其根必须有 `catalog.json`。`catalog.json` 是 JSON 对象，`catalog_id` / `item_id` 为**必填非空字符串**；`item_revision` 可选（整数 ≥ 0，缺省 0）；**tags 写在 `metadata.tags`（字符串数组）**。`title` / `description` 等业务字段可选，随目录一起进存档。

```bash
mkdir -p my-catalog
cat > my-catalog/catalog.json <<'EOF'
{
  "catalog_id": "demo-catalog-001",
  "item_id": "demo-item-001",
  "item_revision": 0,
  "title": "示例商品（虚构）",
  "description": "用于演示发布/检索的虚构商品目录",
  "metadata": { "tags": ["示例", "标签"] }
}
EOF
```

> 关键：tags 只允许出现在 `catalog.json` 的 `metadata.tags`，**不能**放进 LISTING_REF。indexer 从通告中的轻量 catalog card 提取 tags，并用 manifest + `catalog_hash` 校验。

### 2. 写最小 publisher.yaml

```bash
cat > my-publisher.yaml <<'EOF'
agent_id: my-publisher
identity_seed_file: .publisher.seed     # 首次启动自动生成 32 字节种子（0600）
data_dir: .                             # .data/ 的父目录（不是 .data/ 本身）
http: { host: 127.0.0.1, port: 8788 }
log: { level: info }
role: publisher
publisher:
  catalog_dir: ./my-catalog             # 目录内必须有 catalog.json
  trackers: []                          # 单机演示无外部 tracker
  announce_to: ["http://127.0.0.1:8787"]  # 启动即通告此 indexer（基址）
  watch: false
  dht: false                            # 关 DHT，避免挂起
  # 对外部署时填写模型可访问的地址；不要把 0.0.0.0/127.0.0.1 当公网地址广播
  # public_base_url: "https://catalog.example.com"
EOF
```

### 3. 起 publisher

```bash
node dist/cli.js publisher --config my-publisher.yaml
```

启动时发布站会：读目录 → 算 manifest + `catalog_hash` → 本地播种 → 签 LISTING_REF → 存事实 → 按 `announce_to` 自动通告轻量目录卡片。用 `Ctrl-C`（SIGINT）优雅退出。

### 4. 验证 GET /healthz 与 GET /listing-ref

```bash
curl -s http://127.0.0.1:8788/healthz
# 期望 {"ok":true,"role":"publisher","agentId":"my-publisher"}

curl -s http://127.0.0.1:8788/listing-ref > listing-ref.json
cat listing-ref.json
```

`GET /listing-ref` 返回已签 LISTING_REF 信封（JCS 单行 JSON）。记下 `body.catalog_hash`（`sha256:…`，后续镜像/检索都要用）。信封没有存 `object_id` 字段——`object_id` 是「sha256:」+ lowerhex(SHA-256(signing_input)) 的计算值，通告成功时 indexer 会在响应里返回它。

无 jq 时用 node 提取 `catalog_hash`：

```bash
CATALOG_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('listing-ref.json','utf8')).body.catalog_hash)")
echo "$CATALOG_HASH"
```

### 5. 通告到 indexer

发布站启动时已按 `announce_to` 自动通告；若 indexer 当时未就绪，可让 publisher 重发完整通告：

```bash
curl -s -X POST http://127.0.0.1:8788/announce
# 200：{"status":"announced","results":[...]}
```

### 6. 可选：让 indexer 缓存完整目录

普通发布和检索不需要这一步。只有 indexer 自愿承担镜像流量、希望发布站离线后仍能直接提供完整目录时，才从发布站取存档并 PUT：

```bash
CATALOG_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('listing-ref.json','utf8')).body.catalog_hash)")
curl -s "http://127.0.0.1:8788/catalogs/$CATALOG_HASH" > catalog-archive.json

curl -s -X PUT "http://127.0.0.1:8787/catalogs/$CATALOG_HASH" \
  -H 'content-type: application/json' \
  --data-binary @catalog-archive.json
# 成功 201：{"status":"stored","catalog_hash":"sha256:..."}
```

存档是 `{manifest:{files:[{path,sha256}]}, files:[{path, content(base64)}]}`。这只是可选缓存，不是索引收录前置条件。

### 7. 在 indexer 用标签检索验证

```bash
curl -s 'http://127.0.0.1:8787/catalogs?tag=示例&tag=标签'
```

期望命中本目录（AND 语义，两个 tag 都要有）：

```json
{"catalogs":[{"catalog_hash":"sha256:…","tags":["示例","标签"],
  "object_id":"sha256:…","publisher":"my-publisher",
  "catalog_id":"demo-catalog-001","item_id":"demo-item-001","item_revision":0}]}
```

## 验证方法

全部通过即发布成功：

1. `GET /healthz` → 200 且 `role==publisher`、`agentId==my-publisher`。
2. `GET /listing-ref` → 200，返回信封含 `body.catalog_hash` 与 `body.publisher==my-publisher`。
3. `POST /announce/listing-ref`（或启动自动通告）→ 200 `{status:"accepted",object_id}`。
4. `GET /catalogs?tag=示例&tag=标签` → `catalogs[]` 含 `catalog_hash`、`publisher` 与 `distribution_refs`。
5. `GET /catalogs/:hash/card` → 200；完整目录未镜像时 `GET /catalogs/:hash` 可以是 404。

## 常见错误

- **端口被占**（启动报 `EADDRINUSE`）：改 `http.port`，或用环境变量覆盖 `STATION_HTTP_PORT=8789 node dist/cli.js publisher --config my-publisher.yaml`。
- **`data_dir` 写成了 `.data/` 本身**：`data_dir` 是 `.data/` 的**父目录**，写 `.` 或一个专项目录即可，别写 `./.data`。
- **`publisher.catalog_dir: missing catalog.json at the directory root`**：`catalog_dir` 根缺 `catalog.json`，或它不是合法 JSON。
- **`catalog.json: catalog_id must be a non-empty string` / `item_id ...`**：两个字段必填非空字符串。
- **tags 位置错**：tags 必须在 `catalog.json` 的 `metadata.tags`（`string[]`）。放在 LISTING_REF body 或顶层都会失败/不被识别。
- **`identity_conflict`**：同一个 `agent_id` 已经通过 TOFU 绑定了另一个公钥。不要复制或上传私钥；确认 agent_id 是否重用，必要时由索引站运营者检查 `.data/peers/<agentId>.pub`。
- **裸 LISTING_REF 返回 `fail:unknown_signer`**：兼容接口仍接受裸信封，但陌生身份无法仅靠裸信封引导。请调用 publisher 的 `POST /announce`，发送包含公开身份和 catalog card 的完整通告。
- **标签检索查不到**：确认 publisher 的自动通告成功，且 `catalog.json` 带 `metadata.tags`。完整目录 PUT 不再是检索前置条件。

## 附：快速起一个 indexer

没有现成 indexer 时（以 `apps/station/` 为工作目录）：

```bash
cat > my-indexer.yaml <<'EOF'
agent_id: my-indexer
identity_seed_file: .indexer.seed
data_dir: .
http: { host: 127.0.0.1, port: 8787 }
log: { level: info }
role: indexer
indexer:
  weights_file: ../demo-indexer/weights.json   # 相对进程工作目录解析
EOF
node dist/cli.js indexer --config my-indexer.yaml
```

然后直接起 publisher；首次启动会在 `identity_seed_file` 指定的位置生成该站自己的全新身份，首次完整通告会自动引导公钥。不要把 `protocol/test-vectors/` 中的公开身份用于跨机器试运行，也不要把发布站的种子复制给 indexer。
