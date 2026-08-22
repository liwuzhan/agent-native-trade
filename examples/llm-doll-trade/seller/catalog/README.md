# 棉花研究所 · 2026 春夏目录（虚构演示数据）

本目录是 M11 演示中"卖方发布的棉花娃娃套装目录"，**全部虚构**，无真实商品与价格。

- 目录 ID：`cotton-doll-catalog-2026`
- 发布方：`agent_seller`（种子取自 `protocol/test-vectors/vectors.json` 的 `agent_seller`）
- 文件清单（torrent 相对路径以 `catalog/` 为前缀）：

| 文件 | 内容 |
|---|---|
| `catalog/cotton-doll-set-basic.json` | 基础套装 20cm（68.00 CNY） |
| `catalog/cotton-doll-deluxe-set.json` | 豪华套装 25cm（128.00 CNY，限定款） |
| `catalog/cotton-doll-accessories.json` | 配件包（32.00 CNY） |
| `catalog/pricing-2026.json` | 全量价目（十进制定点字符串） |
| `catalog/README.md` | 本说明 |

演示中该目录被：
1. 用 `@agent-trade/bt-catalog` 做 canonical manifest + `catalog_hash`，并以本地 tracker 播种（`seed(seller/catalog)`）；
2. 卖方签发 `LISTING_REF`（`catalog_hash` + `distribution_refs: [magnet, email]`）；
3. 检索站（demo-indexer）以 HTTP 镜像存档（`PUT /catalogs/:hash`）；
4. 卖方与 tracker 下线后，买方仍能从镜像取回（`GET /catalogs/:hash`），校验逐字节一致。
