# 模块卡片：M8 demo-indexer

- **目标**：实现 `apps/demo-indexer`——极简检索站：回执收录/验签/证据验证/权重配置/签名静态导出/本地查询 CLI/目录存档镜像。证明"收录方独立赋权"与"服务器死亡评价体系不消失"。
- **输入**：`@agent-trade/signed-files`（M2）、`@agent-trade/local-store`（M3）、`@agent-trade/bt-catalog`（M4）；技术选型 V0.4 §5。

## 输出

`apps/demo-indexer/`（hono + better-sqlite3），HTTP 端点 + CLI：

```text
POST /receipts            # 提交 TRADE_RECEIPT（可含 evidence.bundle），验签+证据验证后收录
GET  /subjects/:agentId   # 聚合视图：按当前权重配置算分，列出收录的回执
GET  /export              # 下载签名静态快照 receipts-index.json（聚合+快照哈希+本站签名）
PUT  /catalogs/:hash      # 上传目录包存档（HTTP 镜像）
GET  /catalogs/:hash      # 下载历史目录（卖家下线后仍可取）

CLI:
indexer export --output receipts-index.json        # 离线导出
indexer query <snapshot> --subject <agentId>       # 本地离线查询（无需服务器）
```

规则：

- 收录流程：验签（M2 verifyFile）→ 去重（receipt_id + 内容哈希）→ 证据验证（bundle 优先；在线抓取兜底且带超时+大小上限）→ 入库；
- 权重规则全部在配置文件（如 `weights.json`：是否要求 deal_ref、是否要求结算事件、各证据档位的分值），**不同配置必须能产生不同评分**；
- 快照文件自身按统一信封签名（`object_type` 复用 `TRADE_RECEIPT` 之外不做新类型——快照用 plain JSON + detached 签名文件 `receipts-index.sig`，验签逻辑复用 M2）；
- 目录镜像按 `catalog_hash` 存取，上传时校验 manifest。

依赖：`hono`、`@hono/node-server`、`better-sqlite3`、内部三包；dev：`vitest`。

## 验收指标（即测试）

1. 提交篡改回执（用 M0 篡改向量）被拒；合法回执收录并可查。
2. **双实例不同权重**：同一回执集在两个不同 `weights.json` 下评分不同（脚本演示）。
3. **静态导出 + 离线查询**：export 后杀掉服务器进程，`indexer query` 仍能回答 subject 评分；快照签名验证通过。
4. 证据验证：无 bundle 且引用不可达的 `deal_ref` → 该证据档分数为 0，但回执可收录为低档；含 bundle 且验签通过 → 高档分。
5. 目录镜像：PUT 后 GET 可取回逐字节一致内容；manifest 校验失败的包被拒。
6. `vitest run` 全绿；`tsc -b` 无错误。

## 边界

- 不做：SEO、垃圾过滤、用户体系、公网部署；在线抓取只做兜底且必须有超时/大小上限。
