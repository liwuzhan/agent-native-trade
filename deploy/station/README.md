# Station 双站模板

同一个镜像启动一个 indexer 和一个 publisher。首次通告会自动交换**公钥**和轻量 catalog card；不复制私钥，也不把完整商品目录上传给 indexer。

```bash
cp deploy/station/.env.example deploy/station/.env
docker compose --env-file deploy/station/.env -f deploy/station/compose.yaml up --build -d
curl 'http://127.0.0.1:8787/catalogs?tag=空调维修'
```

把 `catalog/catalog.json` 替换为真实目录。对外部署时，把 `.env` 的 `PUBLISHER_PUBLIC_BASE_URL` 改成模型可访问的发布站基址，并由反向代理提供 TLS、限流和访问日志。

模板默认把两个端口只绑定到 `127.0.0.1`，避免廉价服务器在没有反向代理时直接暴露。需要对外开放时，请显式修改 `compose.yaml` 的端口绑定或接入隧道；完整目录镜像仍是可选项。
