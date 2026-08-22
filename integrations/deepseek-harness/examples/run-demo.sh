#!/usr/bin/env bash
# run-demo.sh — M10 最小链路脚本化演示（验收指标 1）。
# 用法：
#   bash integrations/deepseek-harness/examples/run-demo.sh
# 前置：
#   1) bash integrations/deepseek-harness/install-presets.sh  （构建 + 安装 preset，demo 依赖 dist/server.js）
#   2) node integrations/deepseek-harness/examples/setup-catalog.mjs  （身份/目录/邮件 spool 预置，可重复执行）
set -eu
cd "$(dirname "$0")"
echo "== 重置演示数据（幂等重跑）=="
rm -rf "${AGENT_TRADE_DEMO_ROOT:-$HOME/.agent-trade}"
echo "== 预置演示数据 =="
node setup-catalog.mjs
echo "== 运行最小链路演示 =="
node demo.mjs
