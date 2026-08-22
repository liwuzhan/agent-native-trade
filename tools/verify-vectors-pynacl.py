#!/usr/bin/env python3
"""第三独立实现的验签器：PyNaCl(libsodium) + Python 版 JCS。
注意：Python 按码点排序键，JCS 按 UTF-16 码元排序——仅对非 BMP 字符有差异；
当前向量数据全部为 BMP 字符，行为一致。非 BMP 进入向量前需处理此差异。"""
import json, hashlib, base64, sys, pathlib
from nacl.signing import VerifyKey
from nacl.exceptions import BadSignatureError

root = pathlib.Path(__file__).resolve().parent.parent
v = json.loads((root / 'protocol/test-vectors/vectors.json').read_text(encoding='utf-8'))

def jcs(x):
    if x is None: return 'null'
    if isinstance(x, bool): return 'true' if x else 'false'  # bool 先于 int 判断
    if isinstance(x, int): return str(x)
    if isinstance(x, float): return json.dumps(x)
    if isinstance(x, str): return json.dumps(x, ensure_ascii=False)
    if isinstance(x, list): return '[' + ','.join(jcs(i) for i in x) + ']'
    if isinstance(x, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + jcs(x[k]) for k in sorted(x.keys())) + '}'
    raise TypeError(type(x))

def b64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))

def verify_file(f, identities):
    actual = 'sha256:' + hashlib.sha256(jcs(f['body']).encode('utf-8')).hexdigest()
    if actual != f['body_hash']:
        return 'fail:body_hash_mismatch'
    inp = f['protocol'].encode() + b'\x00' + f['object_type'].encode() + b'\x00' + f['body_hash'].encode()
    for s in f['signatures']:
        idt = identities.get(s['signer'])
        if not idt: return 'fail:unknown_signer'
        try:
            VerifyKey(b64u(idt['public_key'])).verify(inp, b64u(s['signature']))
        except BadSignatureError:
            return 'fail:signature_invalid'
    return 'valid'

bad = 0
for c in v['cases']:
    got = verify_file(c['file'], v['identities'])
    ok = got == c['expect']
    print(('OK ' if ok else 'BAD'), c['name'].ljust(34), 'got=' + got)
    if not ok: bad += 1
sys.exit(1 if bad else 0)
