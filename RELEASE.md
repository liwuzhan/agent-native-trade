# 发布清单（v0.2.0）

## 前置验收

- [ ] `bash tools/verify-all.sh` PASS（构建 + 全部测试 + 三实现验签）
- [ ] `bash examples/llm-doll-trade/run-demo.sh` 全绿（11 步闭环）
- [ ] M4 手动 DHT 验收在真实网络执行并记录结果（**本环境 2026-08-23 失败：网络受限，需在开放网络复跑**）
- [ ] M9 桌面客户端（Claude Desktop/Cursor）人工兼容性测试记录

## 发布步骤

1. `git tag -a v0.2.0 -m "agent-trade/0.2 reference implementation"`
2. GitHub：`gh repo create agent-trade-protocol --public --source . --push`（或网页建仓后 `git remote add origin ... && git push -u origin main --tags`）
3. Gitee：网页建仓（勾选 Apache-2.0）→ `git remote add gitee git@gitee.com:<user>/agent-trade-protocol.git` → `git push gitee main --tags`
4. 仓库描述统一写：`agent-trade/0.2 — 以模型为主体的开放交易闭环协议参考实现。权威源：protocol/test-vectors/`
5. 双镜像同步策略：主开发在 GitHub，Gitee 作为镜像（每次发布 `git push gitee main --tags`）。

## 发布声明要点

- 协议权威是测试向量，不是任何服务器或仓库；
- 玩票阶段定位：小额实验，安全口径见技术选型 §12；
- 已知限制见 FUTURE.md（密钥轮换列首位）。
