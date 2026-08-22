# INSPECTION.md — DSH（DeepSeek Harness）真实接口探测记录

> 模块：M10 DSH 集成 · 状态：**离线预备（运行时探测未开始）**
> 本文档是 `cordis_inspect_*` 探测结果的唯一落点。任何注册代码必须与本文档记录的**运行时验证过**的接口一致（M10 验收指标 3）。
> 第一部分是**已从本机安装目录读取验证**的格式事实；第二部分是**待探测问题清单**（运行时第一步执行）。

---

## 第一部分：离线已验证（来自本机安装目录）

探测对象：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/config/agent-presets/`（真实打包安装，含 `cordis` / `code` / `standard` / `minimal` 四个 preset，各含 `preset.yml` + `agent.cordis.yml`；`cordis` 另含 `skills/<name>/SKILL.md` 两个）。

### 1.1 preset.yml 格式

真实样例（`cordis/preset.yml` 全文）：

```yaml
name: 创造模式
description: 用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。
order: 4
```

要点（对照 `standard`/`minimal`/`code` 的 preset.yml，均仅此三个字段）：

- 字段：`name`（显示名，中文）、`description`（一句话能力说明）、`order`（**仅打包内置 preset 的目录排序**；本地自建 preset 无需 `order`，见 `editing-cordis-compositions` SKILL："Write the metadata too: a preset without it shows up in every picker as its bare directory name"——本地 preset 至少要有 `name` + `description`）。
- 无 schema 版本、无其他字段。

### 1.2 agent.cordis.yml 格式

真实样例：`cordis/agent.cordis.yml`（263 行）、`code/agent.cordis.yml`（263 行）、`minimal/agent.cordis.yml`（88 行）。要点：

- 顶层是 **YAML 文档列表**，每个元素是一个"插件行"（row）：
  ```yaml
  - id: persona                     # 会话内唯一 id
    name: '@deepseek-ai/dsh-persona' # 插件包名（作用域限定名）
    config:                          # 该行的配置（按插件不同）
      text: |-
        ...
  ```
- 可选字段：`disabled`（如 `disabled: !!js process.platform === 'win32'`）、`group: true` + `isolate:`（`cordis:group` 组行，把一组行放进条目本地 realm，如 `isolate: { planMode: true }`、`isolate: { terminals: true }`、`isolate: { fs: true }`）。
- **JS 表达式**用 `!!js` 标签（如 `cwd: !!js process.env.DSH_CWD ?? process.cwd()`、`disabled: !!js process.platform === 'win32'`）。
- persona 行样例（`code/agent.cordis.yml` L31-35）：
  ```yaml
  - id: persona
    name: '@deepseek-ai/dsh-persona'
    config:
      text: >-
        You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
  ```
  `{{model}}` / `{{cwd}}` 从 agent 自身路由与工作区解析（打包注释原文）。`minimal` 的 persona 行另有 `complete: true`、`includeRuntimeContext: false`（persona 作为完整 system prompt 时使用）。
- agent-instructions 行样例（`code/agent.cordis.yml` L37-40）：
  ```yaml
  - id: agent-instructions
    name: '@deepseek-ai/dsh-agent-instructions'
    config:
      maxBytes: 65536
  ```
- 文件系统 / skill 挂载行（`cordis/agent.cordis.yml` L256-263，`baseUrl` 为 preset 自身目录）：
  ```yaml
  - id: skill-filesystem
    name: '@deepseek-ai/dsh-skill-filesystem'
    config:
      customSkillDirs:
        - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
  - id: tool-skill
    name: '@deepseek-ai/dsh-tool-skill'
  ```
- 工具行样例（`standard` / `cordis` / `code` 中多处）：`tool-bash`（`name: '@deepseek-ai/dsh-tool-bash'` + `disabled`）、`tool-fs`（`'@deepseek-ai/dsh-tool-fs'`）、`tool-fs-search`（`'@deepseek-ai/dsh-tool-fs-search'`，config `sampleOverCapGlobResults: false`）、`tool-jobs`、`tool-goal`、`tool-web`、`tool-ask-user`、`tool-todo`、`tool-workflow`、`tool-ralph`、`tool-subagent`（config: provider/toolName/backgroundMode）等。
- 平面规则（来自打包注释与 `editing-cordis-compositions` SKILL，属已验证文档事实）：preset 是 **AGENT-PLANE** 组合，只贡献"一个会话"的东西（工具、persona、提示段）；注册表的行（`tools`/`subagents`/`goals` 等 registry）必须留在 HOST 组合。**发布 Service 的行在 preset 里必须放进带 `isolate` 的 group**，否则第二个会话挂载会冲突、挂载校验直接拒绝。

### 1.3 SKILL.md 格式

真实样例：`cordis/skills/cordis-plugin-development/SKILL.md`（420 行）、`cordis/skills/editing-cordis-compositions/SKILL.md`。要点：

- 文件头是 **YAML frontmatter**，仅两个键：
  ```yaml
  ---
  name: cordis-plugin-development
  description: Create, modify, debug, or extend dynamic Cordis Plugins, ...（一段话）
  ---
  ```
- 正文为 Markdown：`#` 标题 + 章节；用表格给出"Tool / Use it when / Do not"、"Requirement / Preferred platform / Inspect first"等；用 fenced code block 给 `cordis_inspect_query` 的 JSON 请求样例与 `code.host`/`code.client` 的 JS 样例。
- 技能目录布局：`skills/<skill-name>/SKILL.md`（目录名 = frontmatter `name`）。

### 1.4 动态插件工具链——已知命令名（**来自打包文档，运行时待验证**）

来源：`cordis/skills/cordis-plugin-development/SKILL.md`（打包文档，非运行时实测）。文档列出的工具：

| 命令 | 文档语义 |
| --- | --- |
| `cordis_inspect_list` | 一次调用列出 Host/Client 当前注册的 Providers 与方法 schema；"Hard-code Provider names and skip list" 是反模式 |
| `cordis_inspect_query` | 精确查询某 Service/Event/Builtin/Slot/Token/Tool 的契约（如 `{ "service": "timer" }`、`{ "event": "..." }`） |
| `cordis_inspect_self(pluginId, packageId)` | 读取现有 Plugin 的版本指针、Package 源码与运行时诊断 |
| `cordis_define` | 创建 Plugin 首个版本或追加不可变 Package；`plugin.kind: 'existing'` + 原 pluginId 用于修改；返回 `packageId` |
| `cordis_run` | 激活某个 Package（首次 `run`、换版本 `update`、回滚 `run`）；返回 `awaiting-approval` / `starting` 等异步状态 |
| `cordis_stop` | 暂停 Plugin 效果、保留 Packages/grants/版本指针 |
| `cordis_undefine` | 永久删除 Plugin 及其全部 Packages（文档：仅在确认不再需要时使用） |

文档还给出（同属"打包文档，运行时待验证"）：

- 生命周期概念：`pluginId`（稳定实例）≠ `packageId`（不可变代码版本）≠ `pluginRunId`（每次激活尝试）。
- `code.host` / `code.client` 是**纯 JS 函数体**（非 TS/JSX/import），返回一个 Cordis Plugin（`{ apply(ctx) {...} }`）；全局符号（`process`/`Buffer`/`fetch`/原生 timer）**未经 `Builtin.listBuiltins` 确认即不可用**；timer 是名为 `timer` 的 Service（需 `inject: ['timer']`）。
- 读可选 Service 用 `ctx.get(name)` 并处理 undefined；硬依赖才 `inject`。
- Host 侧动态工具注册示例（`editing-cordis-compositions` SKILL）：`harness.registerTool(ctx, harness.defineTool({ name, description, parameters, output, async execute(args) {...} }))`；工具参数与返回值必须 JSON 兼容；`execute` 拥有业务结果，render/presentation 只负责模型与原生 UI 所见；工具注册必须属于当前 Plugin Fiber（stop/update 后自动移除）。
- Client→Host 私有 RPC：Host `harness.handle(method, handler)`，Client `host.call(method, args)`，参数/返回必须是无损 JSON。
- **内部活数据**（Service 实例、Event payload、Slot props、Session/Tool state）禁止 `JSON.stringify`/`structuredClone`/整体枚举，只读所需叶子标量。

> ⚠️ 本部分全部来自安装目录的打包文件（真实格式），但**任何一行未被运行时 `cordis_inspect_list` 复验的调用都不算验证通过**（M10 卡片第一步红线："禁止凭印象写 Cordis API"）。

---

## 第二部分：运行时待探测清单（第一步：在运行中的 DSH 会话里执行）

> 每项 = 「问题」+「打算怎么验」。所有项以 `cordis_inspect_list`（先）与 `cordis_inspect_query`/`cordis_inspect_self`（后）为准；只读优先，探针插件最小化。

### A. 工具注册与目录

1. **动态工具注册的确切 API**：`harness` Builtin 的精确方法名与签名（`defineTool`/`registerTool` 的参数结构、`output.render` 的形状约束、execute 的 args 形态）是否与打包文档一致？
   → 先 `cordis_inspect_list` 看 Host 目录；再 `cordis_inspect_query`（`Builtin.listBuiltins`）读 `harness` 签名；用 `Tool.listTools` 对照现有工具 schema。最后用探针插件（只读、无副作用）注册一个最小工具验证往返。

2. **cordis 工具名与参数逐条确认**：打包文档里的 `cordis_inspect_list/query/self`、`cordis_define/run/stop/undefine` 的实际名称、必填参数、返回字段（含 `pluginId`/`packageId`/`pluginRunId`、`awaiting-approval`/`starting` 等状态值）是否一致？有没有额外/改名的工具？
   → 逐条 `cordis_inspect_list` 核对；`list`/`query`/`self` 先做只读最小调用；`define` 的调用形态用一个探针 Plugin 验证（内容为无害的日志插件）。

3. **动态工具的生命周期与作用域**：工具注册是否真的随当前 Plugin Fiber 在 stop/update 后自动移除？工具目录按会话隔离还是全局共享？
   → 注册探针工具 → `cordis_stop` → `Tool.listTools` 确认消失；再开第二个会话看目录隔离性（影响"工具名冲突"设计）。

4. **preset 挂载校验的实际行为**：`agentPresets` Service（`list()`/`read()`/`standingKeyFor(id)`/`copy()`）签名与返回；挂载失败时报错文本是否精确到行。
   → 照 `editing-cordis-compositions` 样例临时插件注入 `agentPresets` 注册 `preset_check` 工具，对 `trade-buyer`/`trade-seller` 各验证一次。

5. **skills 挂载与 frontmatter 解析**：`skill-filesystem` 的 `customSkillDirs` + `baseUrl` 是否按预期解析到 preset 目录的 `skills/`；SKILL.md frontmatter 的解析规则（`description` 长度限制？缺 `name` 的行为？）。
   → 挂载后经 `tool-skill` 目录确认 6 个技能可见可读；故意写坏一个 frontmatter 观察报错，再修复。

### B. host 侧能力边界

6. **host 侧 fs 能力边界**：`code.host` 里 `fs` Service 的确切方法（读写、路径规则、是否受沙箱策略约束）——交易工具需要读写 `.data/`（keys、deal 文件、tasks、store）。
   → `Service.listService` 无参列出全部 Service；对 `fs` 逐项 query 方法签名与访问规则；用探针工具读/写工作区内临时文件验证。

7. **host 侧网络能力边界**：`code.host` 是否有网络原语（`web`/fetch/`subprocess`）？交易工具若需拉取不可信内容（邮件/附件/目录）必须先明确边界与限流。
   → `Service.listService` + `Builtin.listBuiltins` 确认有无网络符号；若有，规划白名单/限大小/超时，并登记进 INSPECTION。

8. **密码学原语可用性**：Ed25519、SHA-256、JCS 在 `code.host` 里怎么实现（Node crypto？noble？还是无原语，必须在宿主层 TS 包算好、插件只做薄封装）？这决定插件是厚是薄、以及 M10 验收 2（逻辑层可单测）的架构落点。
   → `Builtin.listBuiltins` 查 crypto 相关符号；若无，则确认走"宿主层 `@agent-trade/*` 包 + 插件薄封装"路线（本仓库已具备 M2/M3/M6 包，逻辑层全部可单测，插件仅做参数透传与返回值裁剪）。

### C. 数据与策略

9. **工具返回值的渲染约束**：`output.render` 支持哪些 render 类型；模型看到的工具返回是否就是 `execute` 的返回值（决定"摘要 + object_id"是否只需在 execute 里裁剪）。
   → 探针工具分别返回不同 render 形状，观察模型侧与 UI 侧呈现；读 `Tool.listTools` 返回 schema 里的 `output` 定义。

10. **预算策略的落点**：`max_amount_per_deal` 等策略文件（如 `policy.json`）由谁读、放哪里（`$DSH_HOME`？工作区？host fs 服务的路径规则）；`trade_sign_deal` 超限拒绝的返回形态。
    → 确认 `fs` Service 可读路径后，放策略文件 → 探针工具读取 → 设计拒绝文案（含原因，M9 验收 2 要求）。

### D. 运行环境与事件

11. **code.host 运行环境约束**：确认代码体是纯 JS（无 import/require/TS）；`process`/`Buffer`/`fetch` 是否真不可用；`timer` Service 与 `inject` 声明是否如文档。
    → 探针插件分别引用这些符号，看 `cordis_define`/`cordis_run` 的诊断信息（文档"Common failure checks"表给过对应报错）。

12. **persona 合并与占位符解析**：preset 的 persona 行是否覆盖部署默认；`{{model}}`/`{{cwd}}` 实际解析结果；`complete: true`/`includeRuntimeContext` 的影响（对照 `minimal`）。
    → 挂载 `trade-buyer` 会话，用 `cordis_inspect_self` 或会话系统提示观察 persona 实际文本。

13. **Event 能力（可选，登记用）**：若后续要做"对方签好 DEAL 的通知"，Event Provider 的 mode（emit/waterfall）与监听器签名。
    → `Event.listEvents` 无参列出，再 query 目标事件。**M10 最小链路不依赖事件**，属 FUTURE。

14. **Client 侧能力（明确不做）**：`code.client`、Slot、`host.call` 仅当需要 UI 时使用；M10 边界"不做 client UI"，登记为 FUTURE，不探测（若顺手可在 `cordis_inspect_list` 里看 Client 目录，但不阻塞）。

---

## 探测执行记录（运行时填写）

| 日期 | 会话 | 执行项 | 结论/证据 |
| --- | --- | --- | --- |
| （待探测） | — | — | — |
