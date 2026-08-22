#!/usr/bin/env bash
# M11 棉花娃娃端到端演示 · 一键脚本
#
#   bash run-demo.sh                 # 默认 loopback（无 Docker）：M5 邮件走共享内存信箱
#   RUN_MODE=greenmail bash run-demo.sh   # 需 Docker：走 adapters/email 的 GreenMail 容器
#
# 从干净状态（rm -rf runlog）执行 11 步（协议文档 §9E），随后逐步断言，
# 断言全绿即最终验收通过。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "==> 首次运行：npm install（file: 接线 + @modelcontextprotocol/client）"
  npm install --no-audit --no-fund
fi

export NODE_OPTIONS="--no-warnings ${NODE_OPTIONS:-}"
RUN_MODE="${RUN_MODE:-loopback}"

echo "================================================================"
echo " M11 棉花娃娃端到端演示 · mode=${RUN_MODE}"
echo "================================================================"

echo "==> 1/3 清理 runlog/（干净状态）"
rm -rf runlog
mkdir -p runlog

echo "==> 2/3 执行 11 步演示（demo.mjs）"
node demo.mjs

echo ""
echo "==> 3/3 逐步断言（assertions.mjs）"
node assertions.mjs

echo ""
echo "✅ M11 演示通过：11 步闭环 + 断言全绿"
echo "   摘要：runlog/demo-summary.json（每步 object_id / 文件路径 / 评分）"
echo "   剧本：README.md"
