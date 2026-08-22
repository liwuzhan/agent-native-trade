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

## 模块状态（2026-08-23）

| 模块 | 状态 | 测试 |
|---|---|---|
| M0 protocol（schemas + test-vectors） | ✅ | 三实现互验（node:crypto / OpenSSL / PyNaCl） |
| M1 identity | ✅ | 18/18 |
| M2 signed-files | ✅ | 25/25 |
| M3 local-store | ✅ | 19/19（+ M10 公钥信任环扩展：`.data/peers/`） |
| M4 bt-catalog | ✅ | 21/21（DHT 验收为手动脚本） |
| M5 email | ✅ | 47 单元 + GreenMail 集成（CI） |
| M6 settlement | ✅ | 12/12 |
| M7 human-task | ✅ | 23/23 |
| M8 demo-indexer | ✅ | 30/30 |
| M9 mcp-server | ✅ | 28/28（含 stdio 冒烟 + 12 红线） |
| M10 DSH 集成 | ✅ | 14/14 单测 + 最小链路 9 步演示 + 双 preset 挂载校验 + 会话内往返 |
| M11 棉花娃娃端到端 | ✅ | 106 断言全绿（run-demo.sh） |

### M10 快速开始（DSH 集成）

```bash
bash integrations/deepseek-harness/install-presets.sh   # 构建 + 安装 trade-buyer/trade-seller preset
node integrations/deepseek-harness/examples/setup-catalog.mjs  # 预置演示身份/目录
bash integrations/deepseek-harness/examples/run-demo.sh # 最小链路 9 步脚本化演示
export AGENT_TRADE_REPO="$(pwd)"                        # DSH 会话进程环境（行 config 兜底）
```

接口探测记录：`integrations/deepseek-harness/INSPECTION.md`（运行时验证过的 Cordis API）。


模块卡片见 `docs/module-cards/`。

## 模板站（2026-08-23）

`apps/station/`：单工件三角色（indexer / publisher / integrator），配置即角色。S1–S6 全部完成：三角色 46 测试、互演 demo（`examples/station-demo.sh`）、"5 分钟起站"文档、SKILL.md 六个（干净会话实操验收通过，见 `docs/s6-acceptance.md`）。
