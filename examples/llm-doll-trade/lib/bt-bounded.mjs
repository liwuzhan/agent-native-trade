/**
 * lib/bt-bounded.mjs — 有界（可取消）的 WebTorrent 播种/下载。
 *
 * 背景（M11 集成层兜底）：`@agent-trade/bt-catalog` 的 `seed`/`download`
 * 不暴露超时/取消；若下载在部分环境偶发挂起，其内部 WebTorrent 客户端会
 * 一直持有 socket/timer，拖住整个进程不退出。这里提供语义相同的
 * `seedBounded`/`downloadBounded`：在 `timeoutMs` 内未 ready/done 即**销毁
 * 客户端**并以"超时"拒绝 —— 调用方（demo.mjs）据此降级到索引站 HTTP 镜像，
 * 进程不会无限挂起。
 *
 * 与 bt-catalog 的差异仅在"超时即销毁"，成功路径行为一致（manifest 由下载
 * 文件经 canonical buildManifest 重建，catalog_hash 可比对）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import WebTorrent from 'webtorrent';

import { buildManifest } from '@agent-trade/bt-catalog';

/** 销毁客户端（忽略错误，安全重复调用）。 */
function destroyClient(client) {
  return new Promise((resolve) => {
    try {
      client.destroy(() => resolve());
    } catch {
      resolve(); // 已销毁
    }
  });
}

/**
 * 同 bt-catalog `seed`，但 timeoutMs 内未就绪即销毁客户端并拒绝。
 * 返回 { infoHash, magnetURI, torrentFile, stop }。
 */
export function seedBounded(dir, opts = {}, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = new WebTorrent({ dht: opts.dht ?? true, lsd: false, tracker: true });
    const timer = setTimeout(() => {
      void destroyClient(client).then(() => reject(new Error(`seedBounded 超时（${timeoutMs}ms）`)));
    }, timeoutMs);
    const fail = (err) => {
      clearTimeout(timer);
      void destroyClient(client).finally(() => reject(err instanceof Error ? err : new Error(String(err))));
    };
    client.on('error', fail);

    let torrent;
    try {
      torrent = client.seed(dir, { announce: opts.tracker ?? [] });
    } catch (err) {
      fail(err);
      return;
    }
    torrent.on('error', fail);
    torrent.on('ready', () => {
      clearTimeout(timer);
      resolve({
        infoHash: torrent.infoHash,
        magnetURI: torrent.magnetURI,
        torrentFile: new Uint8Array(torrent.torrentFile),
        stop: () => destroyClient(client),
      });
    });
  });
}

/**
 * 同 bt-catalog `download`，但 timeoutMs 内未完成即销毁客户端并拒绝。
 * 成功返回由下载文件重建的 canonical Manifest。
 */
export function downloadBounded(magnetURI, destDir, opts = {}, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = new WebTorrent({ dht: opts.dht ?? true, lsd: false, tracker: true });
    const timer = setTimeout(() => {
      void destroyClient(client).then(() => reject(new Error(`downloadBounded 超时（${timeoutMs}ms）`)));
    }, timeoutMs);
    const fail = (err) => {
      clearTimeout(timer);
      void destroyClient(client).finally(() => reject(err instanceof Error ? err : new Error(String(err))));
    };
    client.on('error', fail);

    let torrent;
    try {
      torrent = client.add(magnetURI, { path: destDir, announce: opts.tracker ?? [] });
    } catch (err) {
      fail(err);
      return;
    }
    torrent.on('error', fail);
    torrent.on('done', () => {
      (async () => {
        const files = [];
        for (const file of torrent.files) {
          const buf = await fs.promises.readFile(path.join(destDir, file.path));
          files.push({ path: file.path, data: new Uint8Array(buf) });
        }
        const manifest = buildManifest(files);
        await destroyClient(client);
        clearTimeout(timer);
        resolve(manifest);
      })().catch(fail);
    });
  });
}
