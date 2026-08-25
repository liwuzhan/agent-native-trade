#!/usr/bin/env bash
# 仓库级总验收：构建 + 全部包测试 + 三实现向量验签。
# 用法：bash tools/verify-all.sh
# pipefail 是硬要求：下面测试步骤的输出经过 grep 管道，没有 pipefail 时
# 管道退出码取自 grep（只要输出里有匹配行就是 0），测试失败会被吞掉。
set -u -o pipefail
cd "$(dirname "$0")/.."
fail=0

echo "=== 根构建 (tsc -b) ==="
npm run build || fail=1

for d in packages/identity packages/signed-files packages/local-store packages/bt-catalog \
         adapters/email adapters/settlement adapters/human-task \
         apps/demo-indexer apps/mcp-server apps/station integrations/deepseek-harness/plugin; do
  echo "=== $d ==="
  # 走 npm test 而不是 npx vitest run：各包的 pretest 钩子必须执行
  # （如 DSH 插件的 build:bundle、mcp-server 的 schema 抽取），
  # 否则 bundle 冒烟测试在干净检出上必然失败。
  (cd "$d" && npm test 2>&1 | grep -E "Tests .*passed|failed|Error") || fail=1
done

echo "=== 测试向量：node:crypto 参考验签器 ==="
node tools/verify-test-vectors.mjs | tail -1 || fail=1
echo "=== 测试向量：OpenSSL ==="
bash tools/verify-vectors-openssl.sh | grep -c "^OK" || fail=1
echo "=== 测试向量：PyNaCl ==="
python3 tools/verify-vectors-pynacl.py > /dev/null && echo "pynacl OK" || fail=1

[ $fail -eq 0 ] && echo "== verify-all: PASS ==" || echo "== verify-all: FAIL =="
exit $fail
