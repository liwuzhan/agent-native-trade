# 模块卡片：S5 三角色互演 demo + 部署文档

- **目标**：一键演示发布站→整合商→索引站全链路，并提供"5 分钟起一个站"的部署文档。
- **输入**：S2/S3/S4 已验收；M11 的编排经验（超时/降级/断言模式可借鉴）。

## 输出

```text
apps/station/examples/
├── station-demo.sh        # 干净状态一键演示
├── README.md              # 5 分钟起站指南（三角色各一节）
└── configs/               # 演示用三份 yaml
```

演示链路：publisher 发布棉花娃娃服务目录 → integrator 合成"春季专题" → indexer 收录 → 标签检索命中 → 买方下载目录 →（用既有包签 DEAL + 回执）→ 回执 POST indexer → 快照导出 → 杀服务器离线查询。全程步骤级 30s 超时，BT 20s 超时 + 镜像降级。

## 验收指标

1. `bash station-demo.sh` 从干净状态全绿（断言脚本逐步检查：verifyFile valid、标签命中、评分非零、离线查询 valid）。
2. publisher 进程杀掉后，indexer 镜像仍可供目录（断言）。
3. README 三角色各含：最小 yaml、启动命令、验证命令（curl 示例）、常见问题；零基础用户按文档可在 5 分钟内起任一站。
4. 演示数据全部虚构，无真实秘密。

## 边界

- 不做 docker 镜像实测（本机无 docker）；compose/Dockerfile 正确性由 CI 静态检查。
- 不写生产部署（systemd/nginx）教程，只给开发/演示形态。
