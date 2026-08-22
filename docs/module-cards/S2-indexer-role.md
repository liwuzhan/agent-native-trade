# 模块卡片：S2 indexer 角色（M8 生产化）

- **目标**：把 M8 demo-indexer 内核接入 station indexer 角色，新增**黄页标签检索**与只读状态页，实现 S1 的通告契约。**首条验收：M8 既有测试不失效。**
- **输入**：S1（StationContext/契约）、M8（apps/demo-indexer，内核含收录/验签/证据档/权重/快照/镜像）。

## 输出

`apps/station/src/roles/indexer/`：

```text
start(ctx) →
  POST /announce/listing-ref   # S1 契约：验签 → 收录目录引用
  POST /receipts               # 复用 M8
  GET  /subjects/:agentId      # 复用 M8
  GET  /export                 # 复用 M8（签名快照）
  PUT/GET /catalogs/:hash      # 复用 M8 镜像
  GET  /catalogs?tag=a&tag=b   # 【新】黄页：按标签检索已收录目录（AND 语义）
  GET  /                       # 【新】只读状态页：单 HTML（收录计数、最新回执、本站公钥、weights_hash）
```

规则：

- 目录 metadata 的标签从 LISTING_REF body 的扩展字段读取（`tags?: string[]`——这是 LISTING_REF body 的可选扩展，**不得改协议 schema**；无 tags 的目录不出现在黄页但仍在镜像里）；
- M8 内核**不重写**：能 import 就 import（若 demo-indexer 无合适导出面，在 station 内做薄 adapter 包裹并在报告登记）；
- weights 走 config 的 `indexer.weights_file`；改动文件即生效（重启或 watch 二选一，选实现简单的）。

依赖：S1 基座、M8 内核；dev：vitest。

## 验收指标（即测试）

1. **M8 全部既有测试不失效**（`apps/demo-indexer` vitest 仍绿）。
2. 标签检索：收录带 `tags:["朝阳","家电维修"]` 的 LISTING_REF 后 `?tag=朝阳` 命中、`?tag=海淀` 不命中；多 tag AND。
3. 状态页 GET / 返回 200 text/html，含收录回执数、目录数、本站公钥、weights_hash。
4. 契约符合性：对 `/announce/listing-ref` 投递篡改信封 → 400 + verify_result；重复投递同内容 → 200 幂等；同 object_id 异内容 → 409。
5. config 换 weights 文件后评分变化。
6. `vitest run` 全绿；`tsc -b` 零错误。

## 边界

- 不做坐标搜索/SEO/反垃圾/账号；状态页无 JS 框架、无交互（纯展示）。
- 只准在 apps/station/ 内工作；如需动 M8 导出面，只做**加法**导出并在报告说明。
