/**
 * plugin.mjs — agent-trade/0.2 DSH 集成插件（模块 M10）。
 *
 * 零依赖 ESM 静态 Cordis 插件：作为 preset 行加载（`name: './plugin.mjs'`，
 * 行解析规则见 INSPECTION.md 1.2）。职责（薄封装）：
 *   - 把 tool-spec.json 的 18 个工具注册到会话作用域（ctx.tools.register）；
 *   - 每个工具 = 参数透传 + 懒启动 JSONL daemon（subprocess stdin pipe）+ 返回裁剪；
 *   - 交易逻辑、密码学、红线校验全部在 daemon（@agent-trade/* 包）内完成。
 *
 * 行 config（全部可选，环境变量兜底）：
 *   repoRoot     仓库根（daemon 入口 = repoRoot/integrations/deepseek-harness/plugin/dist/server.js）
 *                —— 缺省 AGENT_TRADE_REPO，再缺省报配置错误（工具仍注册，调用时返回明确错误）
 *   tradeDir     交易数据根（.data/ 所在），缺省 AGENT_TRADE_DATA_DIR ?? process.cwd()
 *   agentId      默认 actor，缺省 AGENT_TRADE_AGENT_ID ?? 'agent'
 *   catalogDir   目录搜索根，缺省 <tradeDir>/.data/catalog
 *   maildropDir  邮件 spool 根，缺省 <tradeDir>/.data/maildrop
 *   mailAddress  本 daemon 收件地址，缺省 'agent@trade.local'
 *   mailPeer     trade_contact_seller 默认收件方
 *   nodeBin      node 可执行文件，缺省 'node'
 *   toolTimeoutMs 单次工具调用超时（缺省 60000）；超时/中止会 terminate daemon 并要求下次重建
 *
 * 生命周期：daemon 懒启动（首次工具调用），ctx dispose 时 terminate；注册随 Fiber 自动移除。
 */

import toolSpec from './tool-spec.json' with { type: 'json' };

export const name = 'trade-tools';

const DEFAULT_TIMEOUT_MS = 60000;

/** canonical 值 schema（INSPECTION.md 3.1：禁 required 数组；additionalProperties 显式）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    object_id: { type: 'string' },
    summary: { type: 'string' },
  },
};

/**
 * 标准 JSON Schema → 注册层形态：直接产出**标准 JSON Schema**（根级
 * type:'object' + properties + required 数组）。
 *
 * 教训（2026-08-23 卖方真实会话失败）：静态注册路径不经过 defineTool 的
 * schemastery 归一化，若给 property-map（无根 type）会原样到达模型适配器，
 * 报 "schema must be a JSON Schema of 'type: \"object\"', got 'type: null'"。
 * 打包工具的 parameters 内部归一化结果即 {type:'object', properties, required[]}
 * （对照模型侧 bash 工具 schema 实测），本转换器直接产出该形态。
 */
export function dshParametersOf(schema) {
  const properties = {};
  const source = schema && typeof schema === 'object' ? schema : {};
  const sourceProperties = source.properties && typeof source.properties === 'object' ? source.properties : {};
  for (const [key, def] of Object.entries(sourceProperties)) {
    if (def === null || typeof def !== 'object') continue;
    const entry = {};
    if (typeof def.type === 'string') entry.type = def.type;
    if (typeof def.description === 'string') entry.description = def.description;
    if (Array.isArray(def.enum)) entry.enum = def.enum;
    if (def.type === 'array' && def.items && typeof def.items.type === 'string') entry.items = { type: def.items.type };
    properties[key] = entry;
  }
  const out = { type: 'object', properties };
  if (Array.isArray(source.required) && source.required.length > 0) out.required = source.required;
  return out;
}

/**
 * JSONL daemon 客户端：懒 spawn + 行协议 + 超时/中止语义。
 * 只依赖 subprocess Service 与 Node 流对象的方法调用，不引入任何 npm 依赖。
 */
function makeDaemonClient(ctx, config) {
  const subprocess = ctx.get('subprocess');
  const serverJs = config.serverJs;
  const cwd = config.repoRoot;
  const argvArgs = [
    'serve',
    '--dir', config.tradeDir,
    '--agent-id', config.agentId,
  ];
  if (config.catalogDir) argvArgs.push('--catalog-dir', config.catalogDir);
  if (config.maildropDir) argvArgs.push('--maildrop', config.maildropDir);
  if (config.mailAddress) argvArgs.push('--mail-address', config.mailAddress);
  if (config.mailPeer) argvArgs.push('--mail-peer', config.mailPeer);

  let handle = null;        // SubprocessHandle | null
  let readyResolve = null;  // () => void
  let readyPromise = null;  // Promise<void> | null
  let stdoutBuffer = '';
  let stderrTail = '';
  let nextId = 1;
  const pending = new Map(); // id → { resolve, reject, timer }
  let disposed = false;

  function failAllPending(message) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    pending.clear();
  }

  function onLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（防御性忽略）
    }
    if (parsed && parsed.event === 'ready') {
      if (readyResolve !== null) {
        readyResolve();
        readyResolve = null;
      }
      return;
    }
    if (parsed && typeof parsed.id === 'string' && pending.has(parsed.id)) {
      const p = pending.get(parsed.id);
      pending.delete(parsed.id);
      clearTimeout(p.timer);
      if (parsed.ok === true) p.resolve(parsed.result);
      else p.reject(new Error((parsed.error && parsed.error.message) || 'daemon error'));
    }
  }

  function onStdout(chunk) {
    stdoutBuffer += String(chunk);
    let idx;
    while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      onLine(line);
    }
  }

  function killDaemon(reason) {
    failAllPending(reason);
    if (handle !== null) {
      try {
        handle.terminate();
      } catch {
        /* noop */
      }
      handle = null;
    }
    readyPromise = null;
    readyResolve = null;
  }

  function ensure() {
    if (disposed) return Promise.reject(new Error('trade tools: plugin disposed'));
    if (config.repoRoot === '') {
      return Promise.reject(
        new Error('trade tools not configured: set row config "repoRoot" (or env AGENT_TRADE_REPO) to the agent-trade-protocol repo root'),
      );
    }
    if (subprocess === undefined) {
      return Promise.reject(new Error('trade tools: subprocess service unavailable in this runtime'));
    }
    if (handle !== null && readyPromise !== null) return readyPromise;

    const handleNow = subprocess.spawn({
      argv: [config.nodeBin, serverJs, ...argvArgs],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 5000,
    });
    handle = handleNow;
    handleNow.stdout.on('data', onStdout);
    handleNow.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000);
    });
    void handleNow.done.then((outcome) => {
      if (handle !== handleNow) return; // 已被替换
      handle = null;
      failAllPending(
        `trade daemon exited (code=${String(outcome.exitCode)}, signal=${String(outcome.signal)}) stderr=${stderrTail.slice(-300)}`,
      );
      readyPromise = null;
      readyResolve = null;
    });

    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      const bootTimer = setTimeout(() => {
        if (readyResolve !== null) {
          readyResolve = null;
          killDaemon('trade daemon boot timeout');
          reject(new Error('trade daemon boot timeout'));
        }
      }, 15000);
      void handleNow.done.then(() => clearTimeout(bootTimer));
    });
    return readyPromise;
  }

  return {
    async call(tool, args, signal, timeoutMs) {
      await ensure();
      if (handle === null || handle.stdin === undefined) {
        throw new Error('trade tools: daemon not available');
      }
      return new Promise((resolve, reject) => {
        const id = String(nextId++);
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          pending.delete(id);
          if (abortHandler !== null) signal.removeEventListener('abort', abortHandler);
          fn(value);
        };
        let abortHandler = null;
        if (signal !== null && typeof signal.addEventListener === 'function') {
          abortHandler = () => {
            killDaemon('trade tool call aborted');
            finish(reject, new Error('trade tool call aborted'));
          };
          if (signal.aborted) {
            abortHandler();
            return;
          }
          signal.addEventListener('abort', abortHandler);
        }
        const timer = setTimeout(() => {
          killDaemon('trade tool call timeout');
          finish(reject, new Error(`trade tool call timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e), timer });
        handle.stdin.write(JSON.stringify({ id, tool, args }) + '\n');
      });
    },
    dispose() {
      disposed = true;
      killDaemon('plugin disposed');
    },
  };
}

export function apply(ctx, config = {}) {
  const tools = ctx.get('tools');
  if (tools === undefined) return;

  const opts = {
    repoRoot: typeof config.repoRoot === 'string' && config.repoRoot.length > 0 ? config.repoRoot : process.env.AGENT_TRADE_REPO ?? '',
    tradeDir:
      typeof config.tradeDir === 'string' && config.tradeDir.length > 0
        ? config.tradeDir
        : process.env.AGENT_TRADE_DATA_DIR ?? process.cwd(),
    agentId:
      typeof config.agentId === 'string' && config.agentId.length > 0
        ? config.agentId
        : process.env.AGENT_TRADE_AGENT_ID ?? 'agent',
    catalogDir: typeof config.catalogDir === 'string' && config.catalogDir.length > 0 ? config.catalogDir : undefined,
    maildropDir: typeof config.maildropDir === 'string' && config.maildropDir.length > 0 ? config.maildropDir : undefined,
    mailAddress: typeof config.mailAddress === 'string' && config.mailAddress.length > 0 ? config.mailAddress : undefined,
    mailPeer: typeof config.mailPeer === 'string' && config.mailPeer.length > 0 ? config.mailPeer : undefined,
    nodeBin: typeof config.nodeBin === 'string' && config.nodeBin.length > 0 ? config.nodeBin : 'node',
    toolTimeoutMs: typeof config.toolTimeoutMs === 'number' && config.toolTimeoutMs > 0 ? config.toolTimeoutMs : DEFAULT_TIMEOUT_MS,
  };
  opts.serverJs = `${opts.repoRoot}/integrations/deepseek-harness/plugin/dist/server.js`;

  const client = makeDaemonClient(ctx, opts);

  for (const tool of toolSpec.tools) {
    tools.register({
      name: tool.name,
      description: tool.description,
      parameters: dshParametersOf(tool.parameters),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [
          { type: 'text', text: typeof value.summary === 'string' ? value.summary : String(value ?? '') },
        ],
      },
      async execute(args, exec) {
        const signal = exec && exec.signal && typeof exec.signal.addEventListener === 'function' ? exec.signal : null;
        return client.call(tool.name, args, signal, opts.toolTimeoutMs);
      },
    });
  }

  ctx.on('dispose', () => client.dispose());
}
