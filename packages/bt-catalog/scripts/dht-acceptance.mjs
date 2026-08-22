#!/usr/bin/env node
/**
 * DHT acceptance — MANUAL, NOT part of CI (acceptance criterion #4).
 *
 * Verifies that a buyer can fetch a catalog using ONLY a magnet URI over the
 * public BitTorrent DHT:
 *
 *   - no tracker: neither side gets tracker URLs, and the magnet carries no
 *     `tr=` parameter;
 *   - no preconfigured content peers: peer discovery happens purely via DHT
 *     (webtorrent's built-in bittorrent-dht node);
 *   - the seller seeds and waits for its DHT announce; the buyer then
 *     downloads with the bare magnet.
 *
 * This needs a real network that can reach public DHT bootstrap nodes
 * (router.bittorrent.com:6881 / dht.transmissionbt.com:6881 /
 * router.utorrent.com:6881). Run it manually on a live network and record the
 * output:
 *
 *   npm run build        # script imports ../dist/index.js
 *   node scripts/dht-acceptance.mjs [--announce-wait 15] [--timeout 120]
 *
 * Exit code 0 = PASS, 1 = FAIL.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const ANNOUNCE_WAIT_S = flag('--announce-wait', 15);
const DOWNLOAD_TIMEOUT_S = flag('--timeout', 120);

const DIST = new URL('../dist/index.js', import.meta.url);
const SRC_DIR = 'catalog-dht';

let failures = 0;
const step = (msg) => console.log(`\n[step] ${msg}`);
const ok = (msg) => console.log(`  ok   ${msg}`);
const bad = (msg) => {
  failures += 1;
  console.log(`  FAIL ${msg}`);
};

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Recursively read a directory into { path, data } (relative forward-slash paths). */
async function readDir(root) {
  const out = [];
  async function walk(dir, rel) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(abs, relPath);
      else if (entry.isFile()) out.push({ path: relPath, data: new Uint8Array(await fs.promises.readFile(abs)) });
    }
  }
  await walk(root, '');
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`node ${process.version} — DHT acceptance (announce-wait ${ANNOUNCE_WAIT_S}s, download timeout ${DOWNLOAD_TIMEOUT_S}s)`);

  if (!fs.existsSync(DIST)) {
    console.error('dist/index.js not found — run `npm run build` in packages/bt-catalog first.');
    process.exit(1);
  }
  const { seed, download, buildManifest, catalogHash, verifyCatalogFiles } = await import(DIST.href);

  step('create seed directory with mixed content');
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bt-catalog-dht-'));
  const seedDir = path.join(work, SRC_DIR);
  await fs.promises.mkdir(path.join(seedDir, 'nested'), { recursive: true });
  await fs.promises.writeFile(path.join(seedDir, 'readme.txt'), 'agent-trade DHT acceptance catalog\n');
  await fs.promises.writeFile(path.join(seedDir, 'payload.bin'), Buffer.from([0, 1, 2, 253, 254, 255]));
  await fs.promises.writeFile(path.join(seedDir, 'nested', 'deep.json'), JSON.stringify({ hello: 'dht', n: 42 }));
  ok(`seeded files under ${seedDir}`);

  step('seller: seed WITHOUT tracker, DHT on, and wait for the DHT announce');
  console.log('  …announcing to the public DHT (bootstrap nodes must be reachable)…');
  const seeder = await seed(seedDir, { dht: true });
  ok(`infoHash  ${seeder.infoHash}`);
  ok(`magnet    ${seeder.magnetURI}`);
  if (seeder.magnetURI.includes('tr=')) bad('magnet URI must NOT contain a tracker (tr=)');
  else ok('magnet carries no tr= parameter (tracker-free as required)');
  console.log(`  …keeping the seeder alive for ${ANNOUNCE_WAIT_S}s so the DHT announce propagates…`);
  for (let s = 1; s <= ANNOUNCE_WAIT_S; s++) {
    await sleep(1000);
    if (s % 5 === 0 || s === ANNOUNCE_WAIT_S) console.log(`  …announce wait ${s}/${ANNOUNCE_WAIT_S}s`);
  }

  step('buyer: download with ONLY the magnet (no tracker, no preconfigured peers)');
  const destDir = path.join(work, 'download');
  await fs.promises.mkdir(destDir, { recursive: true });
  let manifest;
  try {
    manifest = await withTimeout(download(seeder.magnetURI, destDir, { dht: true }), DOWNLOAD_TIMEOUT_S * 1000, 'DHT download');
    ok(`downloaded ${manifest.files.length} file(s) via DHT`);
    for (const f of manifest.files) console.log(`    ${f.path}  ${f.sha256}`);
  } catch (err) {
    bad(`DHT download failed: ${err.message}`);
    await seeder.stop();
    await fs.promises.rm(work, { recursive: true, force: true });
    return;
  }

  step('verify downloaded content against the manifest');
  const dlFiles = await readDir(destDir);
  const verify = verifyCatalogFiles(dlFiles, manifest);
  ok(`catalogHash ${catalogHash(manifest)}`);
  if (verify) ok('verifyCatalogFiles PASSED');
  else bad('verifyCatalogFiles FAILED');
  const expected = buildManifest((await readDir(seedDir)).map((f) => ({ path: `${SRC_DIR}/${f.path}`, data: f.data })));
  if (catalogHash(manifest) === catalogHash(expected)) ok('catalog hash matches the seller-side manifest');
  else bad('catalog hash differs from the seller-side manifest');

  step('teardown');
  await seeder.stop();
  await fs.promises.rm(work, { recursive: true, force: true });
  ok('seeder stopped, temp dirs removed');

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFAIL — unexpected error: ${err.stack ?? err}`);
  process.exit(1);
});
