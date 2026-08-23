# S6 验收记录：干净会话实操（2026-08-23）

> 后续架构修订：下面保留的是当时的历史验收记录。当前 Station 已取消“向 indexer 复制发布者种子”和“必须先 PUT 完整目录才可检索”两项前置；完整通告以公钥自举（TOFU）并携带轻量 catalog card，整包镜像仅为可选缓存。对应回归为 Station 48/48、local-store 20/20。

> 验收方法：另起**无任何项目背景**的执行子代理，只给对应 SKILL.md + 环境事实（indexer 地址、工作目录），观察其能否无人工提示完成任务。索引站：http://127.0.0.1:19881（裸 indexer，`/tmp/s6-accept/`）。

## 验收 A：发布（station-publish）—— 通过（含两个真实缺陷发现）

干净子代理按文档虚构商品「二手客制化机械键盘」完成发布，`GET /catalogs?tag=mech-kb` 命中（publisher=agent-a，tags=["二手机械键盘","客制化","mech-kb"]，中文与 AND 语义同样命中）。

**发现的两个缺陷**（文档/代码与现实的偏差，干净会话特有的价值）：

1. **信任环只在 openStore 启动时载入**：运行中写入 `.data/keys/*.key` 后通告仍失败（文档原写"写 key 重发即可"）。子代理被迫读源码、优雅重启 indexer 才成功。
2. **验签失败返回 HTTP 500 而非契约的 400**：`putObject` 的验证错误未被映射（CONTRACT.md 要求 400 + verify_result）。

**修复**（子代理完成，评审通过）：

- `apps/station/src/roles/indexer/trust-ring.ts`（新增）：announce 前重扫 keys 目录并 `saveKey` 注入（热加载，无需重启）；
- `server.ts`：验证类错误映射为 400 + verify_result（500 语义仅留非验证错误）；
- 新增 2 个回归测试（热加载 500→200、篡改签名→400+`fail:signature_invalid`）；station 46/46、local-store 19/19 不失效。

## 验收 B：检索（station-search）—— 通过（零报错）

干净子代理仅凭文档：标签检索 → 取目录存档 → 解码 catalog.json → manifest 校验。回答全部正确：publisher=agent-a；catalog_hash 与重算值一致；tags 完整；`verifyCatalogFiles=true`。未执行目录内容中的任何指令（不可信数据红线被遵守）。

## 结论

- 两份 SKILL.md 足以让无背景模型独立完成发布与检索（A 在排错一次后成功，B 零摩擦）。
- 干净会话验收同时扮演了**文档测试**与**契约测试**：两个缺陷均已修复并回归锁定。
