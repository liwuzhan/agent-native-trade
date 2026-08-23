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
| M3 local-store | ✅ | 20/20（含 TOFU 公钥信任环：`.data/peers/`） |
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

`apps/station/`：单工件三角色（indexer / publisher / integrator），配置即角色。首次完整通告即可用公钥自举并建立轻量索引，不复制发布者私钥，也不要求索引站镜像完整目录；整包 PUT 仅是可选缓存。当前 Station 48 测试，含互演 demo（`examples/station-demo.sh`）和 DSH SKILL 示例。

可直接部署的双站模板见 `deploy/station/`：同一个 Docker 镜像启动 publisher + indexer，默认只绑定本机端口，适合先接反向代理/隧道再开放。

真实公网 + 双 NAT 电脑的首轮互操作测试见 [`docs/distributed-pilot-test-plan-v0.1.md`](docs/distributed-pilot-test-plan-v0.1.md)：先用轻量索引与可选 HTTP 镜像跑通确定性闭环，再单独测 BT / 公网整合商的目录交付能力。
