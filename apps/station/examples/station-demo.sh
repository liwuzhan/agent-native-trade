#!/usr/bin/env bash
# S5 三角色互演演示 · 一键脚本
#
#   bash station-demo.sh
#
# 从干净状态（rm -rf runlog）执行：构建 → 起三角色 → 全链路演示 → 逐步断言。
# 断言全绿即最终验收通过（等价于验收指标 1/2）。
set -euo pipefail
cd "$(dirname "$0")"

echo "================================================================"
echo " S5 三角色互演演示 · 发布站 → 整合商 → 索引站"
echo "================================================================"

echo "==> 1/4 构建 station（增量 tsc -b，幂等）"
(cd .. && npx tsc -b)

echo "==> 2/4 清理 runlog/（干净状态）"
rm -rf runlog
mkdir -p runlog

echo "==> 3/4 执行演示（demo.mjs）"
node demo.mjs

echo ""
echo "==> 4/4 逐步断言（assertions.mjs）"
node assertions.mjs

echo ""
echo "✅ S5 演示通过：三角色闭环 + 断言全绿"
echo "   摘要：runlog/demo-summary.json"
echo "   剧本：README.md"
