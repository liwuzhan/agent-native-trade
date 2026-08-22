/**
 * jsonl-client.mjs — 验收演示用的最小 daemon 客户端（零依赖，仅 node 内建）。
 * spawn `node <plugin>/dist/server.js serve ...` 并走 JSONL 行协议（见
 * plugin/src/contract.ts）。演示脚本扮演"模型"角色：发起工具调用并做决策。
 */

import { spawn } from 'node:child_process';

export function startDaemon(serverJs, args) {
  const child = spawn(process.execPath, [serverJs, 'serve', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const lines = [];
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      lines.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
    waiters.splice(0).forEach((w) => w());
  });
  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });

  const nextLine = async (timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    while (lines.length === 0) {
      if (Date.now() > deadline) throw new Error(`daemon timeout; stderr=${stderrTail}`);
      await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return lines.shift();
  };

  let nextId = 1;
  const call = async (tool, args) => {
    const id = String(nextId++);
    child.stdin.write(JSON.stringify({ id, tool, args }) + '\n');
    // 消费行直到自己的响应（跳过中间的事件行）
    for (;;) {
      const line = await nextLine();
      const resp = JSON.parse(line);
      if (resp && resp.id === id) {
        if (resp.ok !== true) throw new Error(`${tool}: ${resp.error?.message ?? 'daemon error'}`);
        return resp.result;
      }
    }
  };

  const ready = async (timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`daemon boot timeout; stderr=${stderrTail}`);
      const line = await nextLine(Math.max(1, deadline - Date.now()));
      const parsed = JSON.parse(line);
      if (parsed && parsed.event === 'ready') return;
    }
  };

  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.on('exit', resolve);
      setTimeout(resolve, 5000);
    });
  };

  return { call, ready, stop };
}
