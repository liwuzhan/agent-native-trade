#!/usr/bin/env bash
# 仓库级总验收：构建 + 全部包测试 + 三实现向量验签。
# 用法：bash tools/verify-all.sh
set -u
cd "$(dirname "$0")/.."
fail=0

echo "=== 根构建 (tsc -b) ==="
npm run build || fail=1

for d in packages/identity packages/signed-files packages/local-store packages/bt-catalog \
         adapters/email adapters/settlement adapters/human-task \
         apps/demo-indexer apps/mcp-server apps/station integrations/deepseek-harness/plugin; do
  echo "=== $d ==="
  (cd "$d" && npx vitest run 2>&1 | grep -E "Tests .*passed|failed") || fail=1
done

echo "=== 测试向量：node:crypto 参考验签器 ==="
node tools/verify-test-vectors.mjs | tail -1 || fail=1
echo "=== 测试向量：OpenSSL ==="
bash tools/verify-vectors-openssl.sh | grep -c "^OK" || fail=1
echo "=== 测试向量：PyNaCl ==="
python3 tools/verify-vectors-pynacl.py > /dev/null && echo "pynacl OK" || fail=1

[ $fail -eq 0 ] && echo "== verify-all: PASS ==" || echo "== verify-all: FAIL =="
exit $fail
