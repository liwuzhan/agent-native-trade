# seller/ — 卖方模型配置与目录

M11 演示中卖方（`agent_seller`）的数据目录。

- `config.json` — 身份、邮箱、目录 ID、BT tracker 地址（固定端口 16881，保证 magnet/object_id 可复现）。
- `catalog/` — 棉花娃娃套装目录（全部虚构），即被播种、签发 `LISTING_REF`、并由检索站镜像存档的源文件。

身份种子不在此处复制：演示运行时从权威源
`protocol/test-vectors/vectors.json#identities.agent_seller` 读取（与 M9 测试同法）。
