#!/usr/bin/env bash
# install-presets.sh — 把 M10 的 trade-buyer / trade-seller preset 安装进本地 DSH。
#
# 步骤：
#   1) 构建插件包（tsc -b，产出 dist/server.js —— daemon 入口）；
#   2) 把两个 preset 目录（含零依赖 plugin.mjs / tool-spec.json / skills/）
#      复制到 ${DSH_HOME:-~/.dsh}/.agent-presets/；
#   3) 挂载校验由 DSH 会话内执行（agentPresets.standingKeyFor），或直接用
#      `dsh` 新建会话选择 preset。
#
# 环境变量（可选，运行时也读）：
#   AGENT_TRADE_REPO        仓库根（行 config repoRoot 的兜底；建议导出）
#   AGENT_TRADE_DATA_DIR    覆盖买方/卖方 tradeDir
#   AGENT_TRADE_CATALOG_DIR 覆盖共享目录根
#   AGENT_TRADE_MAILDROP    覆盖共享邮件 spool 根
#
# 本脚本只安装 preset，不是干净克隆的全仓安装器。模型接入流程、依赖构建顺序、
# AgentMail 配置和验收标准见仓库根 AGENT_SETUP.md。
set -eu
cd "$(dirname "$0")"

REPO_ROOT="$(cd ../.. && pwd)"
PRESET_ROOT="${DSH_HOME:-$HOME/.dsh}/.agent-presets"

echo "== 构建插件包（tsc -b）=="
(cd plugin && npm run build --if-present || npx tsc -b)

echo "== 安装 preset 到 $PRESET_ROOT =="
mkdir -p "$PRESET_ROOT"
for preset in trade-buyer trade-seller; do
  dest="$PRESET_ROOT/$preset"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp "presets/$preset/agent.cordis.yml" "$dest/agent.cordis.yml"
  cp "presets/$preset/preset.yml" "$dest/preset.yml"
  cp "presets/$preset/persona.md" "$dest/persona.md" 2>/dev/null || true
  # 零依赖静态插件随 preset 目录分发（行 name: './plugin.mjs' 按 preset 目录解析）
  cp plugin/plugin.mjs "$dest/plugin.mjs"
  cp plugin/tool-spec.json "$dest/tool-spec.json"
  mkdir -p "$dest/skills"
  cp -R skills/. "$dest/skills/"
  echo "  installed $dest"
done

cat <<EOF

安装完成。下一步：
  1) 阅读 $REPO_ROOT/AGENT_SETUP.md；先跑本地回环，再接真实邮箱；
  2) 导出仓库根（DSH 会话进程环境）：export AGENT_TRADE_REPO="$REPO_ROOT"
  3) 新建 DSH 会话时选择 preset「交易买方」/「交易卖方」；
  4) 目录演示数据：node integrations/deepseek-harness/examples/setup-catalog.mjs
  5) 最小链路脚本化演示：bash integrations/deepseek-harness/examples/run-demo.sh
  6) contact bridge 演示：bash integrations/deepseek-harness/examples/run-contact-demo.sh
  7) 挂载校验（在带 cordis 工具的会话内）：
       agentPresets.standingKeyFor('trade-buyer') / ('trade-seller')
EOF
