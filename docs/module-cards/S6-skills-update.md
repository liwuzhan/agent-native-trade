# 模块卡片：S6 skills 更新（模型自驱动）

- **目标**：更新/新增 SKILL.md，让模型照着文档就能用 station 完成"发布商品"与"检索商品"，无需人类解释。验收是**真实新会话实操**。
- **输入**：S5 完成后的可用 station；`integrations/deepseek-harness/skills/` 现有 6 个 SKILL.md；M10 的 18 工具语义。

## 输出

1. 新增/修订 SKILL.md（放在 `integrations/deepseek-harness/skills/`）：
   - `station-publish`：如何准备目录 JSON → 起 publisher → 通告 → 验证（含 curl 示例与排错）；
   - `station-search`：如何按标签检索 indexer → 取目录 → 解读 LISTING_REF；
   - 修订既有 `catalog-search`/`catalog-get-item`：指向 station 端点与字段；
2. 每个 SKILL.md 含：frontmatter（name/description）、用途、前置（起好的 station 地址）、步骤、验证方法、常见错误。
3. 验收记录 `docs/s6-acceptance.md`：新会话 transcript 摘要。

## 验收指标（即测试，由父代理执行）

1. **干净会话测试 A（发布）**：只给模型 SKILL.md 内容 + 一个运行中的 station 地址，无其他上下文，模型成功发布一个虚构商品目录且 indexer 可检索到。
2. **干净会话测试 B（检索）**：同样条件，模型按标签找到已发布目录并正确解读 LISTING_REF（说出 publisher、catalog_hash、tags）。
3. SKILL.md 无虚构端点/字段（与 station 真实行为一致，父代理抽查）。

## 边界

- 只写文档与示例，不改 station 代码；发现 skill 文档无法覆盖的缺口，记录在报告而非改代码。
