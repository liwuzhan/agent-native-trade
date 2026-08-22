---
name: station-publish
description: 用 station 的 publisher 角色发布一个商品目录并通告给 indexer，使其可被标签检索。步骤：准备目录 JSON（metadata.tags 写在 catalog.json）→ 写最小 publisher.yaml → 起 publisher → 验证 GET /listing-ref → 通告 POST /announce/listing-ref → 镜像 PUT /catalogs/:hash → 在 indexer 用 GET /catalogs?tag=… 验证命中。含 curl 示例与常见错误（端口占用、data_dir 语义、tags 位置、验签失败排查）。
---

# station-publish

## 用途

用 station 的 publisher 角色「发布一个商品」，最终让 indexer 能按标签检索到它。发布站只负责：读目录 → 计算 manifest/catalog_hash → 签 LISTING_REF → 通告 LISTING_REF。要让目录**可被标签检索**，还必须把目录存档镜像到 indexer（`PUT /catalogs/:hash`，indexer 从中提取 `metadata.tags`）。

## 前置

1. Node ≥ 24，且 station 已构建（生成 `dist/cli.js`）：

   ```bash
   cd apps/station
   npx tsc -b
   ```

2. 一个**运行中的 indexer**，记其基址为 `INDEXER`（示例 `http://127.0.0.1:8787`）。可用 `curl -s $INDEXER/healthz` 确认，期望 `{"ok":true,"role":"indexer","agentId":"..."}`。没有现成 indexer 时见文末「附：快速起一个 indexer」。

3. indexer 的信任环里必须已含本发布站身份（否则通告被拒，见「常见错误 · 验签失败排查」）。

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

> 关键：tags 只允许出现在 `catalog.json` 的 `metadata.tags`，**不能**放进 LISTING_REF（其 body schema `additionalProperties: false`，塞 tags 会破坏签名）。indexer 是从镜像存档里的 `catalog.json` 提取 tags 的。

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
EOF
```

### 3. 起 publisher

```bash
node dist/cli.js publisher --config my-publisher.yaml
```

启动时发布站会：读目录 → 算 manifest + `catalog_hash` → 本地播种（生成 magnet）→ 签 LISTING_REF → 存事实 → 按 `announce_to` 自动通告 LISTING_REF。用 `Ctrl-C`（SIGINT）优雅退出。

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

发布站启动时已按 `announce_to` 自动通告；若想确认或重发（例如 indexer 之前未就绪），手动通告：

```bash
curl -s -X POST http://127.0.0.1:8787/announce/listing-ref \
  -H 'content-type: application/json' \
  --data-binary @listing-ref.json
# 成功 200：{"status":"accepted","object_id":"sha256:..."}
# 验签/类型失败 400：{"error":"verification failed (fail:...)","verify_result":"fail:..."}
# 同 object_id 异内容冲突 409：{"error":"conflict","object_id":"..."}
```

### 6. 镜像目录到 indexer（否则检索不到）

通告只登记 LISTING_REF；**标签检索还需要把目录存档镜像给 indexer**。从发布站取存档，再 PUT 给 indexer：

```bash
CATALOG_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('listing-ref.json','utf8')).body.catalog_hash)")
curl -s "http://127.0.0.1:8788/catalogs/$CATALOG_HASH" > catalog-archive.json

curl -s -X PUT "http://127.0.0.1:8787/catalogs/$CATALOG_HASH" \
  -H 'content-type: application/json' \
  --data-binary @catalog-archive.json
# 成功 201：{"status":"stored","catalog_hash":"sha256:..."}
```

存档是 `{manifest:{files:[{path,sha256}]}, files:[{path, content(base64)}]}`；indexer 在 `storeCatalog` 里先按 manifest 校验每个文件，再从 `catalog.json`（`catalog.json` 或 `<目录名>/catalog.json`）提取 `metadata.tags`。

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
4. `PUT /catalogs/:hash` → 201 `{status:"stored"}`。
5. `GET /catalogs?tag=示例&tag=标签` → `catalogs[]` 含 `catalog_hash` 与 `publisher==my-publisher`。

## 常见错误

- **端口被占**（启动报 `EADDRINUSE`）：改 `http.port`，或用环境变量覆盖 `STATION_HTTP_PORT=8789 node dist/cli.js publisher --config my-publisher.yaml`。
- **`data_dir` 写成了 `.data/` 本身**：`data_dir` 是 `.data/` 的**父目录**，写 `.` 或一个专项目录即可，别写 `./.data`。
- **`publisher.catalog_dir: missing catalog.json at the directory root`**：`catalog_dir` 根缺 `catalog.json`，或它不是合法 JSON。
- **`catalog.json: catalog_id must be a non-empty string` / `item_id ...`**：两个字段必填非空字符串。
- **tags 位置错**：tags 必须在 `catalog.json` 的 `metadata.tags`（`string[]`）。放在 LISTING_REF body 或顶层都会失败/不被识别。
- **验签失败排查**：`POST /announce/listing-ref` 返回 `400 {"verify_result":"fail:unknown_signer"}` 表示 indexer 信任环没有通告者（`publisher` 字段，即 publisher 的 `agent_id`）的种子。indexer 角色只从 `<indexer data_dir>/.data/keys/<agentId>.key`（种子文件，base64url + 换行，0600）解析 signer。修法：

  ```bash
  # 1) 导出 publisher 的 32 字节种子为 base64url
  PUB_SEED=$(node -e "console.log(Buffer.from(require('fs').readFileSync('.publisher.seed')).toString('base64url'))")
  # 2) 写入 indexer 的信任环（agentId 必须与 publisher 的 agent_id 完全一致）
  mkdir -p "<INDEXER_DATA_DIR>/.data/keys"
  printf '%s\n' "$PUB_SEED" > "<INDEXER_DATA_DIR>/.data/keys/my-publisher.key"
  chmod 600 "<INDEXER_DATA_DIR>/.data/keys/my-publisher.key"
  # 3) 重新通告一次（幂等）
  curl -s -X POST http://127.0.0.1:8787/announce/listing-ref \
    -H 'content-type: application/json' --data-binary @listing-ref.json
  ```

  其它 `verify_result` 取值（与 CONTRACT.md 一致）：`fail:body_hash_mismatch` / `fail:object_id_mismatch` / `fail:schema_invalid` / `fail:signature_invalid` / `fail:protocol_version`——多因手改了信封内容破坏签名，重新从 `GET /listing-ref` 取原始信封即可。
- **标签检索查不到**：只有 `PUT /catalogs/:hash` 镜像过、且其 `catalog.json` 带 `metadata.tags` 的目录才进黄页；**先镜像再检索**。若结果里只有 `{catalog_hash,tags}` 而没有 `publisher/object_id`，说明只镜像未通告——补做第 5 步。

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

然后**先**把发布站种子写入 indexer 信任环（见上「验签失败排查」第 1-2 步，`<INDEXER_DATA_DIR>` 即 `.`），再起 publisher。

> 演示/测试身份可用 `protocol/test-vectors/vectors.json` 的 `agent_buyer` / `agent_seller` 种子——**这只是演示身份，禁止用于生产**。例如用 `agent_seller`（种子 `KonHOvu2k3_LGwqohnSusfSlU7hyO7MrSJFjP_bRqYE`）作发布站：把 `agent_id` 改为 `agent_seller`，并用
> `node -e "require('fs').writeFileSync('.publisher.seed', Buffer.from('KonHOvu2k3_LGwqohnSusfSlU7hyO7MrSJFjP_bRqYE','base64url'))"` 写种子文件；indexer 信任环键名用 `agent_seller.key`。
