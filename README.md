# agent-trade-protocol

以模型为主体的开放交易闭环协议 · 参考实现（Apache-2.0）。

**文档**（设计权威，先读）：
- `../agent-native-trade-protocol-v0.2.md` — 协议总体设计
- `../agent-native-trade-tech-stack-v0.4.md` — 技术选型（含 §16 联动修订清单、§18 交接说明）
- `../agent-native-trade-dev-plan-v0.2.md` — 模块拆分与工期

**本仓库权威源**：`protocol/test-vectors/`。任何实现通过测试向量互验即为合规实现。

## 快速开始

```bash
node tools/generate-test-vectors.mjs     # 生成/再生成测试向量
node tools/verify-test-vectors.mjs       # 用 node:crypto 验证全部向量
bash tools/verify-vectors-openssl.sh     # 用 OpenSSL 交叉验签（第二实现）
```

## 模块状态（2026-08-22）

| 模块 | 状态 | 测试 |
|---|---|---|
| M0 protocol（schemas + test-vectors） | ✅ | 三实现互验（node:crypto / OpenSSL / PyNaCl） |
| M1 identity | ✅ | 18/18 |
| M2 signed-files | ✅ | 25/25 |
| M3 local-store | ✅ | 19/19 |
| M4 bt-catalog | ✅ | 21/21（DHT 验收为手动脚本） |
| M5 email | ✅ | 47 单元 + GreenMail 集成（CI） |
| M6 settlement | ✅ | 12/12 |
| M7 human-task | ✅ | 23/23 |
| M8 demo-indexer | ✅ | 30/30 |
| M9 mcp-server | 🔨 开发中 | — |
| M10 DSH 集成 | ⏳ 待启动（需 DSH 环境探测） | — |
| M11 棉花娃娃端到端 | ⏳ 待启动 | — |

模块卡片见 `docs/module-cards/`。
