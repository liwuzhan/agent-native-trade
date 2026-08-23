# 模块卡片：S4 integrator 角色

- **目标**：实现整合商薄编排：聚合成员目录引用 → 专题目录合成签发 → 可选转播存档 → 通告索引站。
- **输入**：S1、S2/S3 通告契约、M1/M2/M4/M8（镜像/检索参考）。

## 输出

`apps/station/src/roles/integrator/`：

```text
GET /catalog            # 当前专题目录（JSON）
GET /listing-ref        # 当前签名 LISTING_REF
POST /refresh           # 手动触发重新抓取合成
GET /healthz
station integrator --config integrator.yaml
```

配置：`integrator.theme`、`tags[]`、`members[]`（LISTING_REF 文件路径或 URL）、`reseed: bool`、`refresh_interval_ms`（可选，V0 可手动/定时二选一）。

行为：

1. 抓取/读取成员 LISTING_REF，逐一 `verifyFile` 验签，验签失败剔除并日志；
2. 按 theme+tags 合成专题目录（含成员引用、摘要、标签）；保持 canonical manifest 规则；
3. 签自己的 LISTING_REF；提供 HTTP 目录；可选 reseed 成员目录（兼任存档）；
4. 向 `announce_to` 通告公开身份 + 专题 LISTING_REF + 轻量 catalog card；成员目录变更后允许 refresh 重签（新 object_id）。

依赖：S1、M1/M2/M4；dev：vitest。

## 验收指标（即测试）

1. 成员验签：篡改成员 LISTING_REF 被剔除且日志记录；合法成员被收录。
2. 专题目录 manifest 规范（路径/排序/hex 合规），签名 LISTING_REF `verifyFile === 'valid'`，tags 正确。
3. `reseed: true` 时成员目录可经整合商取回（镜像语义）。
4. 通告测试 indexer 后可检索到专题目录；成员更新后 refresh 产生新 object_id。
5. `vitest run` 与 `tsc -b` 全绿。

## 边界

- 不做自动发现（members 只认配置/显式投递）；不做垃圾过滤算法；不做 SEO。
