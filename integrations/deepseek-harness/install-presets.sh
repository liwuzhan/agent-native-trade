#!/usr/bin/env bash
# install-presets.sh — 把 M10 的「交易代理」（trade）preset 安装进本地 DSH。
#
# 2026-09-11：原来的 trade-buyer / trade-seller 两个角色 preset 已合并为单个
# trade preset。两者工具集完全相同，差别只是两段提示词与各自的默认身份/数据根；
# 一个 agent 本来就既买又卖，模式化拆分只会带来配置漂移。现在交易工具统一由
# 标准 bundle 提供（AGENT_SETUP.md §5），preset 只负责人格与技能。
#
# 步骤：
#   1) 构建插件包（tsc -b，产出 dist/server.js —— daemon 入口，供逃生舱行与
#      examples/ 下的脚本使用）；
#   2) 把 preset 目录（agent.cordis.yml / preset.yml / persona.md，以及逃生舱用的
#      零依赖 plugin.mjs / tool-spec.json 与 per-tool skills/）复制到
#      ${DSH_HOME:-~/.dsh}/.agent-presets/；
#   3) 挂载校验由 DSH 会话内执行（agentPresets.standingKeyFor），或直接用
#      `dsh` 新建会话选择 preset。
#
# 说明：preset 里的 trade-tools 行默认 `disabled: true`。默认路径是标准 bundle，
# 它已把 23 个工具注册在宿主层。只有在没装 bundle 的 profile 里才需要打开该行
# （见 agent.cordis.yml 内注释：需 export AGENT_TRADE_REPO）。
#
# 环境变量（可选，运行时也读）：
#   AGENT_TRADE_REPO        仓库根（逃生舱行的 repoRoot 兜底）
#   AGENT_TRADE_DATA_DIR    覆盖 tradeDir（bundle 默认 <DSH_HOME>/agent-trade）
#   AGENT_TRADE_CATALOG_DIR 覆盖目录根
#   AGENT_TRADE_MAILDROP    覆盖邮件 spool 根
#
# 本脚本只安装 preset，不是干净克隆的全仓安装器。模型接入流程、依赖构建顺序、
# AgentMail 配置和验收标准见仓库根 AGENT_SETUP.md。
set -eu
cd "$(dirname "$0")"

REPO_ROOT="$(cd ../.. && pwd)"
PRESET_ROOT="${DSH_HOME:-$HOME/.dsh}/.agent-presets"
PRESET="trade"

echo "== 构建插件包（tsc -b）=="
(cd plugin && npm run build --if-present || npx tsc -b)

echo "== 安装 preset [${PRESET}] 到 $PRESET_ROOT =="
dest="$PRESET_ROOT/$PRESET"
rm -rf "$dest"
mkdir -p "$dest"
cp "presets/$PRESET/agent.cordis.yml" "$dest/agent.cordis.yml"
cp "presets/$PRESET/preset.yml" "$dest/preset.yml"
cp "presets/$PRESET/persona.md" "$dest/persona.md" 2>/dev/null || true
# 零依赖静态插件随 preset 目录分发（逃生舱行 name: './plugin.mjs' 按 preset 目录解析）；
# 默认 disabled，不参与组合。
cp plugin/plugin.mjs "$dest/plugin.mjs"
cp plugin/tool-spec.json "$dest/tool-spec.json"
mkdir -p "$dest/skills"
cp -R skills/. "$dest/skills/"
echo "  installed $dest"

# 已合并的旧角色 preset：目录就是 id，留着会让名单里出现两个用不了的幽灵行。
for legacy in trade-buyer trade-seller; do
  if [ -d "$PRESET_ROOT/$legacy" ]; then
    rm -rf "$PRESET_ROOT/$legacy"
    echo "  removed legacy preset $PRESET_ROOT/$legacy"
  fi
done

cat <<EOF

安装完成。下一步：
  1) 阅读 $REPO_ROOT/AGENT_SETUP.md；先跑本地回环，再接真实邮箱；
  2) 交易工具来自标准 bundle（AGENT_SETUP.md §5）；未安装 bundle 的 profile
     才需要导出仓库根并打开 preset 里的 trade-tools 行：export AGENT_TRADE_REPO="$REPO_ROOT"
  3) 新建 DSH 会话时选择 preset「交易代理」（一个身份既买又卖）；
  4) 目录演示数据：node integrations/deepseek-harness/examples/setup-catalog.mjs
  5) 最小链路脚本化演示：bash integrations/deepseek-harness/examples/run-demo.sh
  6) contact bridge 演示：bash integrations/deepseek-harness/examples/run-contact-demo.sh
  7) 挂载校验（在带 cordis 工具的会话内）：agentPresets.standingKeyFor('trade')
EOF
