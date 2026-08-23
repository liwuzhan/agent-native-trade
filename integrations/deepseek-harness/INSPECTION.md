# INSPECTION.md — DSH（DeepSeek Harness）真实接口探测记录

> 模块：M10 DSH 集成 · 状态：**运行时探测已完成 ✅（2026-08-23，创造模式会话）**
> 本文档是 `cordis_inspect_*` 探测结果的唯一落点。任何注册代码必须与本文档记录的**运行时验证过**的接口一致（M10 验收指标 3）。
> 原"第二部分：待探测清单"已全部结案为「结论 + 证据」；新增第三部分为注册代码速查契约，第四部分为据此做出的架构决策。

---

## 第一部分：离线已验证（来自本机安装目录）+ 运行时复核

探测对象：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/config/agent-presets/`（真实打包安装，含 `cordis` / `code` / `standard` / `minimal` 四个 preset）。

### 1.1 preset.yml 格式（离线已验证，无需复核）

- 字段：`name`（显示名）、`description`（一句话能力说明）、`order`（**仅打包内置 preset**；本地自建 preset 只需 `name` + `description`）。
- 真实样例（`cordis/preset.yml`）：`name: 创造模式` / `description: ...` / `order: 4`。

### 1.2 agent.cordis.yml 格式（离线已验证；行解析规则已在运行时从 loader 源码实读复核）

- 顶层是 **YAML 文档列表**，每元素一个插件行：`id`（会话内唯一）+ `name`（插件名/相对路径）+ 可选 `config` / `disabled`（`!!js` 表达式）/ `group: true` + `isolate:`（`cordis:group` 组行）。
- **行 `name` 解析规则（运行时从 `cordis-plugin-loader/lib/index.js` 实读，L260-272）**：
  - `cordis:` 前缀 → loader 内置（如 `cordis:group`）；
  - 相对路径（`./x.mjs`）→ `new URL(name, baseUrl)`，`baseUrl` 为 **preset 自身目录**（mount 时由 loader 改写，见 `dsh-agent-presets/lib/types/mount.js`）；
  - 裸包名（`@deepseek-ai/...`）→ 从 loader 包位置做普通 ESM `import()`（即 DSH 部署的 node_modules）。
- `!!js` 表达式在 loader 上下文中求值，`process.*` 可用（打包样例用 `process.platform`、`process.getBuiltinModule`）。
- 平面规则：preset 是 **AGENT-PLANE** 组合，只贡献单会话的东西（工具/persona/提示段）；**发布 Service 的行必须放进带 `isolate` 的 group**，否则第二个会话挂载冲突、挂载校验直接拒绝（错误文本见第四部分引用）。

### 1.3 SKILL.md 格式（离线已验证）

- YAML frontmatter 仅两个键：`name`（目录名一致）+ `description`（一段话）；正文 Markdown。

### 1.4 动态插件工具链（**运行时已逐条实测**，与打包文档一致）

| 命令 | 运行时状态 |
| --- | --- |
| `cordis_inspect_list` | ✅ 实测：返回 9 个 Provider（host：Service/Event/Builtin/Tool；client：Service/Event/Builtin/Slots/Theme），各带方法 schema |
| `cordis_inspect_query` | ✅ 实测：platform/provider/method 三键输入；Service 支持无参目录 + 精确契约两级 |
| `cordis_inspect_self` | ✅ 与文档一致（pluginId/packageId 两级） |
| `cordis_define` | ✅ 实测：new→`idPrefix-1/pkg-1`；existing→追加不可变 Package |
| `cordis_run` | ✅ 实测：apply 抛错时**同步返回 Error**（含 defineTool 校验错误文本）；成功返回 `running (run-N)` |
| `cordis_stop` | ✅ 实测：工具自动消失（生命周期验证，见 A3） |
| `cordis_undefine` | 未测（语义与文档一致；收尾时使用） |

---

## 第二部分：运行时探测结论（原 14 问逐项结案）

### A. 工具注册与目录

**A1 ✅ 动态工具注册 API —— 与打包文档一致，另发现三条 DSL 红线。**
`harness.defineTool(definition)` 在 `cordis_run` 时校验，错误文本精确。实测约束（探针 pkg-1/2/3 的拒绝文本）：

1. `parameters`（对象根）**必须开放**：`parameters.additionalProperties must be true or omitted because the implicit parameter root is open`（即对象根不得写 `additionalProperties: false`）；
2. `output.schema` **不支持 `required` 数组**：`unsupported JSON schema: schema.required is not supported by the value schema DSL`；
3. `output.schema` 有 properties 时 **`additionalProperties` 必须显式 true/false**：`unsupported JSON schema: schema.additionalProperties must be explicitly true or false`。
4. **动态沙箱的 `ctx.tools.register` 只收 `harness.defineTool` 产物**：`dynamic tool registration must use a tool returned by harness.defineTool(...)`（静态 preset 插件走真实 registry，不受此限）。

> ⚠️ **静态注册路径教训（2026-08-23 卖方真实会话失败）**：静态插件不经过 `defineTool` 归一化，`parameters` 必须直接是**标准 JSON Schema**（根级 `type:'object'` + properties + required 数组）——给 property-map（无根 type）会原样到达模型适配器：`Invalid schema for function 'catalog_get_item': schema must be a JSON Schema of 'type: "object"', got 'type: null'`（挂载校验 standingKeyFor 不投影模型 schema，拦不住此错；真实会话才暴露）。plugin.mjs 的 `dshParametersOf` 已改为直接产出标准形态，并有单测锁死。

通过校验的正例（pkg-4）即第三部分速查。`harness.registerTool(ctx, tool)` 返回 disposer，注册随 Fiber 生命周期（A3 实测）。

**A2 ✅ cordis_* 工具名与参数** —— 与打包文档逐条一致（本会话实际调用过全部 inspect 工具与 define/run/stop）。

**A3 ✅ 动态工具生命周期** —— 实测闭环：`tprobe-1/pkg-4` 注册 `trade_probe_echo` → `Tool.listTools` 可见（出现在 agent 工具列表）→ 模型直接调用返回 `stdout`（shell 往返 OK）→ `cordis_stop` → 再次 `Tool.listTools` **工具已消失**。结论：注册随当前 Plugin Fiber 自动移除，无需手工清理。

**A4 ⏳ preset 挂载校验** —— `agentPresets` 契约已实测读取（第三部分）；`standingKeyFor(id)` 的实际执行在验收步骤（对 trade-buyer/trade-seller 各一次）。

**A5 ⏳ skills 挂载** —— `customSkillDirs` 行 + `tool-skill` 行按打包样例；实际可见性在真实 preset 会话验收。

### B. host 侧能力边界

**B6 ✅ host 侧 fs** —— `fs` Service 已挂载（探针实测）。契约：`resolve(path,{cwd,signal})→FsTarget`、`readText/writeText/editText/readBytes/listDir/stat/lstat/...`；`writeText` 带 `sandboxPolicy` 参数。**M10 结论：交易工具的文件 IO 全部放在 daemon（Node 进程）内完成，plugin 不直接使用 fs Service**（daemon 用 Node 原生 fs 读写 `.data/`，与 M9/MCP 同构、可单测）。

**B7 ✅ host 侧网络** —— 无 `fetch` 全局；`web` Service（search/fetch）已挂载，`subprocess`/`shell` 可发起任意子进程。**M10 结论：网络活动（邮件/目录分发）全部在 daemon 内由 `adapters/email`、`packages/bt-catalog` 自管超时与大小上限，plugin 不经 `web` Service**。

**B8 ✅ 密码学原语** —— `Builtin.listBuiltins` 仅 `btoa/atob/TextEncoder/TextDecoder`，**无 crypto/Buffer/process**。结论锁定："宿主层 `@agent-trade/*` 包（Ed25519/SHA-256/JCS）+ 插件薄封装" 路线——逻辑层全部在 daemon，可单测（M10 验收 2 的落点）。

**B7/B8 补证：插件沙箱内可用的 Host 全局仅**：`ctx`、`harness`、`console`、`btoa`、`atob`、`TextEncoder`、`TextDecoder`。

### C. 数据与策略

**C9 ✅ 工具返回值渲染** —— `ToolDefinition.output.schema` 是 **canonical 值**的 JSON Schema（每次成功执行后强制校验）；`output.render(args, value) → ContentBlock[]`（`{type:'text', text}` 实测）是模型/UI 看到的内容。模型侧 schema 仅白名单 `name/description/parameters`（`tools.schemas()` 文档 + `Tool.listTools` 实测一致）。结论：**"摘要 + object_id" 在 canonical 值层裁剪，render 只做字符串投影**；daemon 层加 <500 字符硬断言（同 M9 `MAX_RESPONSE_CHARS`）。

**C10 ✅ 预算策略落点** —— 策略文件由 **daemon** 读取（`<tradeDir>/.data/policy.json`，同 M9 `loadPolicy`）；`trade_sign_deal` 超限拒绝在 handler 内（`checkAmountPolicy`），拒绝原因随错误返回。

### D. 运行环境与事件

**D11 ✅ code.host 运行环境** —— 纯 JS 函数体（无 import/require/TS/JSX）；`console.log/error` 可用（带包标签）；全局 `process/Buffer/fetch/原生 timer` 均不存在；timer 是名为 `timer` 的 Service（已挂载，`timeout/interval`）。`ctx.get(name)` 读可选服务、`inject` 声明硬依赖——规则与文档一致。

> ⚠️ **动态沙箱 timer 实测补充（2026-08-23 宿主崩溃后修正）**：声明 `inject: ['timer']` 后可用 `ctx.setTimeout`，但沙箱**不暴露 `ctx.clearTimeout`**（Guard 拒绝："sandbox ctx does not expose clearTimeout … the timer helpers after injecting timer"）；取消语义要走 timer Service 的 disposer 返回（`timeout(cb, ms) → () => void`，见 Service 契约）。且动态插件里的流回调（如 subprocess stdout `data` 处理器）**必须 try/catch 兜底**——未捕获异常会把宿主进程带崩（本会话实测）。静态插件（plugin.mjs）不受此限制（真实 Node 模块）。

**D12 ⏳ persona 合并** —— 在真实 preset 会话验收时观察（`{{model}}`/`{{cwd}}` 解析、persona 行生效）。

**D13 ⏳→FUTURE Event** —— M10 最小链路不依赖事件；「对方已签 DEAL 的通知」登记 FUTURE。Event Provider 目录已存在（host/client 各一），未细探。

**D14 ✅ 明确不做 Client UI** —— M10 边界保持：不加 `code.client`、不查 Slot；工具卡片用默认呈现。Client 侧 Provider 目录已见到（Service/Event/Builtin/Slots/Theme），登记 FUTURE。

---

## 第三部分：注册代码必须一致的 API 契约（速查）

### 3.1 动态工具 DSL（`harness.defineTool` 通过校验的正例，pkg-4 实测）

```js
harness.registerTool(ctx, harness.defineTool({
  name: 'tool_name',                  // 模型可见名
  description: '…',                   // 模型可见描述
  parameters: {                       // 对象根开放（不写 additionalProperties:false）
    type: 'object',
    properties: { arg1: { type: 'string', description: '…' } },
  },
  output: {
    schema: {                         // canonical 值 DSL：禁 required 数组；additionalProperties 显式
      type: 'object',
      properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
      additionalProperties: false,
    },
    render: (args, value) => [{ type: 'text', text: value.summary }],
  },
  async execute(args, exec) { /* JSON 兼容返回值 */ },
}))
```

### 3.2 shell Service（`ctx.get('shell')`，探针实测往返）

```js
const spec = shell.resolve({ command, workdir?, timeoutMs?, stdoutMaxBytes?, stdin?, env? })
const result = await shell.run(spec)
// result: { exitCode:number|null, signal, timedOut, aborted, timeoutMs,
//           stdout: CollectedOutput, stderr: CollectedOutput, sandbox? }
// CollectedOutput: { text:string /*截断时是尾部*/, truncated:boolean, spillPath? }
// 非零退出/超时/中止都 resolve（不 reject）；run 只对基础设施失败 reject
```

### 3.3 subprocess Service（M10 daemon 的宿主；契约读自 `dsh-subprocess` .d.ts + Service 目录）

```js
const handle = subprocess.spawn({
  argv: ['node', '/abs/cli.mjs', 'serve', '--dir', dir],  // 无 shell 解释
  cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'collect' }, graceMs,
})
// handle: { pid, stdin: Writable|undefined, stdout: Readable|undefined,
//           collected: {…}, done: Promise<{exitCode,signal}>, terminate(), waitForExit(signal?) }
// stdin 为 'pipe' 时暴露 Writable——长驻进程 JSONL 协议写入（.d.ts 注释原文）
```

### 3.4 静态插件导出形态（`dsh-tool-skill/lib/index.js` 实读；M10 的 `plugin.mjs` 采用此形态）

```js
// loader.unwrapExports = (exports.default ?? exports) —— named 或 default 均可
export const name = 'plugin-id'            // 可选
export const inject = ['tools']            // 硬依赖才声明
export const Config = z.object({ ... })    // 可选，schemastery schema（行 config 校验）
export function apply(ctx, config = {}) {  // config 来自行的 config 字段
  ctx.tools.register({ /* ToolDefinition，同上 DSL 族 */ })
}
```

静态插件**没有** `harness` 全局（那是动态 Package 专用 Builtin）；注册走 `ctx.tools.register`（inject 或 `ctx.get('tools')`）。

### 3.5 agentPresets Service（`ctx.get('agentPresets')`，精确契约实测）

`list()` / `resolve(id?)` / `mount(agentCtx,id?)` / `composeFrom(agentCtx,parentCtx)` / `composedPreset(agentCtx)` / `read(id)→string` / `copy(from,id,name?)` / `remove(id)` / `serviceFor(agent,name)` / `recompose(agentCtx,id)` / **`standingKeyFor(id?)→ScopeKey`**（挂载校验：组合整棵插件子树，失败四种方式——包不可解析 / config 无效 / 行未激活 / Service 落到根 realm，错误文本点名 offending service；成功则安装 standing generation 直到进程退出）。

### 3.6 Service 挂载实测（本运行时，探针 `trade_probe_services`）

`shell`、`subprocess`、`fs`、`tools`、`skills`、`agentPresets`、`timer`、`web`、`sandbox`、`sandboxPolicy` 全部挂载 ✅

---

## 第四部分：M10 架构决策（探测驱动）

| # | 决策 | 依据（探测项） |
| --- | --- | --- |
| 1 | `plugin.mjs` 为**零依赖 ESM 静态插件**，随 preset 目录分发，行 `name: './plugin.mjs'` | 行解析规则（1.2）：相对名按 preset baseUrl 解析，免 npm 安装 |
| 2 | 插件是**薄封装**：16 个工具 = 参数 JSON 透传 + `subprocess` JSONL 调用 daemon + 返回值裁剪 | B8：插件沙箱无 crypto/Node 原语；M10 验收 2 要求逻辑层可单测 |
| 3 | **daemon = Node 长驻进程**（`node dist/server.js serve`，JSONL over stdin/stdout），持有 `TradeApp` 单例（SQLite store + 内存 voucher/task 注册表） | 3.3 stdin pipe 支持协议写；settlement/human-task 状态必须跨调用存活（M9 `createTradeApp` 单例语义） |
| 4 | 逻辑层**复用 M9 handlers**（compile/sign/verify/record/get_status/receipt/settlement/identity），经 `@agent-trade/mcp-server` 的扩展导出引入；M10 新增 6 工具（catalog_search/catalog_get_item/trade_contact_seller/human_task_create/human_task_complete/trade_broadcast_receipt）在 plugin 包内实现，同样只依赖 `@agent-trade/*` 包 | 技术选型 §8.2："同一套工具语义，内部复用同一批 npm 包" |
| 5 | 签名红线/不可信数据约束**全部在 daemon handlers 内**（同 M9：Schema 先于哈希比对，私钥只读 `.data/keys/`，无人工确认，`policy.json` 超限拒绝；邮件/附件/目录先限大小再校验、绝不执行） | M9 验收 2 红线复用于 M10 |
| 6 | 行 config：`{ repoRoot, tradeDir, agentId }`。`repoRoot` 指向本仓库（daemon 入口 = `repoRoot/integrations/deepseek-harness/plugin/dist/server.js`）；`tradeDir` 同 M9 `AGENT_TRADE_DATA_DIR` 语义 | C10：policy/keys 落点由 daemon 决定 |
| 7 | 不做 client UI、不用 Event、不经 `web` Service（网络在 daemon 内自管超时）；安装 = 复制 preset 目录（含 plugin.mjs）到 `${DSH_HOME}/.agent-presets/` | M10 边界 + D13/D14 |

---

## 探测执行记录

| 日期 | 会话 | 执行项 | 结论/证据 |
| --- | --- | --- | --- |
| 2026-08-23 | 创造模式会话（本会话） | `cordis_inspect_list` | 9 Provider（host 4 + client 5），方法 schema 到手 |
| 2026-08-23 | 同上 | `Builtin.listBuiltins`（host） | 仅 ctx/harness/console/btoa/atob/TextEncoder/TextDecoder；无 crypto/Buffer/process/fetch |
| 2026-08-23 | 同上 | `Service.listService`（无参 + shell/tools/agentPresets 精确） | 46 服务目录；shell/tools/agentPresets 契约全文 |
| 2026-08-23 | 同上 | 安装目录 .d.ts 实读 | ShellExecRequest/Result、CollectedOutput、SubprocessSpawnSpec/Handle/Stdio、ToolDefinition/ToolSchema/ToolOutputDefinition、ContentBlock、loader 行解析、unwrapExports、静态插件导出形态 |
| 2026-08-23 | 同上 | 探针 tprobe-1 pkg-1/2/3 | defineTool DSL 三条拒绝红线（见 A1） |
| 2026-08-23 | 同上 | 探针 tprobe-1 pkg-4 | 注册→`Tool.listTools` 可见→模型调用返回 stdout（node v25.4.0，/opt/homebrew/bin/node）→stop 后消失（A3 闭环） |
| 2026-08-23 | 同上 | 探针 tprobe-1 pkg-5 | apply 异常经 `cordis_run` 同步回报（诊断路径验证） |
| 2026-08-23 | 同上 | 探针 tprobe-1 pkg-6 `trade_probe_services` | shell/subprocess/fs/tools/skills/agentPresets/timer/web/sandbox/sandboxPolicy 全部挂载 |
| 2026-08-23 | 同上 | A2 核对 | cordis_* 工具名/参数与打包文档一致（本会话实际调用） |
| 2026-08-23 | 同上 | preset 挂载校验（standingKeyFor） | `trade-buyer` / `trade-seller` 均 mounted OK（真实组合含 plugin.mjs 行 + skills 行） |
| 2026-08-23 | 同上 | 会话内往返探针（dshtrd v1/v2） | v1 用 `ctx.clearTimeout` + 流回调未兜底 → **宿主进程崩溃一次**（教训写入 D11）；v2（无 clearTimeout、全 try/catch）复跑通过 |
