#!/usr/bin/env bash
# run-contact-demo.sh — contact bridge（runtime bridge contract）脚本化演示。
# 用法：
#   bash integrations/deepseek-harness/examples/run-contact-demo.sh
# 前置：
#   1) bash integrations/deepseek-harness/install-presets.sh  （构建，demo 依赖 dist/server.js）
#   2) node integrations/deepseek-harness/examples/setup-catalog.mjs  （演示目录/身份预置，可重复执行）
# 链路：买方首触询价 → WakeTask → 卖方领取/取信/回信 → 买方被唤醒 → 双方 ack。
# 全链路走 maildrop loopback（无外网依赖）；真实邮箱切换见 preset 行 config 注释。
set -eu
cd "$(dirname "$0")"
echo "== 重置演示数据（幂等重跑）=="
rm -rf "${AGENT_TRADE_DEMO_ROOT:-$HOME/.agent-trade}/contact"
echo "== 预置演示数据 =="
node setup-catalog.mjs
echo "== 运行 contact bridge 演示 =="
node contact-flow.mjs
