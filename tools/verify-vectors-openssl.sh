#!/usr/bin/env bash
# OpenSSL 交叉验签：第二独立实现验证测试向量。
# 正例必须 PASS；名称含 tampered 的负例必须被 OpenSSL 拒绝。
set -u
cd "$(dirname "$0")/../protocol/test-vectors/openssl"
fail=0
for sig in *.sig; do
  base="${sig%.sig}"
  case="${base%.*}"            # 去掉 .<signer> 后缀
  input="$case.input.bin"
  if openssl pkeyutl -verify -rawin -pubin -inkey "$base.pem" -sigfile "$sig" -in "$input" >/dev/null 2>&1; then
    res=PASS
  else
    res=FAIL
  fi
  if [[ "$case" == *tampered* ]]; then want=FAIL; else want=PASS; fi
  if [[ "$res" == "$want" ]]; then
    echo "OK   $base ($res)"
  else
    echo "BAD  $base got=$res want=$want"
    fail=1
  fi
done
exit $fail
