/**
 * M8 acceptance 3: static export + offline query.
 *
 * Export a signed snapshot (HTTP and CLI), kill the server, then `indexer
 * query` must still answer subject scores and the snapshot signature must
 * verify — fully offline, no server process involved.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serialize } from '@agent-trade/signed-files';

import { Indexer } from '../src/indexer.js';
import { parseSnapshot, verifySnapshot } from '../src/snapshot.js';
import { startIndexerServer } from '../src/server.js';
import { defaultWeights, loadVectors, makeDeal, makeReceipt, rmDir } from './helpers.js';

const vectors = loadVectors();
const buyerSeed = vectors.identities.agent_buyer!.seed;
const sellerSeed = vectors.identities.agent_seller!.seed;

const appRoot = new URL('..', import.meta.url).pathname;
const tscBin = new URL('../node_modules/typescript/bin/tsc', import.meta.url).pathname;
const cliPath = new URL('../dist/cli.js', import.meta.url).pathname;

/** Run the real CLI as a child process (requires the tsc -b build); tolerates
 *  non-zero exits so tamper assertions can inspect the failure. */
function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const result = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: result, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function buildReceiptSet() {
  const deal = makeDeal({ buyer: 'agent_buyer', seller: 'agent_seller', secretKey: buyerSeed });
  return [
    makeReceipt({
      subject: 'agent_seller',
      direction: 'buyer_to_seller',
      result: 'COMPLETED',
      rating: 'POSITIVE',
      signer: 'agent_buyer',
      secretKey: buyerSeed,
      dealRef: { object_id: 'sha256:' + 'f'.repeat(64), body_hash: 'sha256:' + '1'.repeat(64) },
      settlementEventRef: 'sha256:' + 'a'.repeat(64),
      bundle: [deal],
    }),
    makeReceipt({
      subject: 'agent_buyer',
      direction: 'seller_to_buyer',
      result: 'COMPLETED',
      rating: 'NEUTRAL',
      signer: 'agent_seller',
      secretKey: sellerSeed,
      comment: 'offline query target',
    }),
  ];
}

const expectedSellerScore = 70; // bundle 40 + deal_ref 10 + settlement 10 + POSITIVE 10
// plain receipt without deal_ref/settlement under default weights:
// evidence none 0 + missing deal_ref -10 + missing settlement -10 + NEUTRAL 2 = -18
const expectedBuyerScore = -18;

describe('acceptance 3: static export + offline query', () => {
  let dir: string;
  let indexer: Indexer;
  let httpExport: string;
  let httpSig: string;

  beforeAll(async () => {
    // The CLI test spawns dist/cli.js — make sure the build is current even
    // when vitest is invoked directly (npx vitest run without pretest).
    if (!existsSync(cliPath)) {
      execFileSync(process.execPath, [tscBin, '-b'], { cwd: appRoot, stdio: 'ignore' });
    }

    dir = mkdtempSync(join(tmpdir(), 'idx-export-http-'));
    indexer = new Indexer({ dir, weights: defaultWeights(), indexerId: 'demo-indexer' });
    indexer.addTrusted('agent_buyer', buyerSeed);
    indexer.addTrusted('agent_seller', sellerSeed);

    // Intake over HTTP, export over HTTP, then kill the server.
    const started = await startIndexerServer(indexer, 0);
    for (const receipt of buildReceiptSet()) {
      const res = await fetch(`http://127.0.0.1:${started.port}/receipts`, { method: 'POST', body: serialize(receipt) });
      expect(res.status).toBe(201);
    }
    const exportRes = await fetch(`http://127.0.0.1:${started.port}/export`);
    expect(exportRes.status).toBe(200);
    const bundle = (await exportRes.json()) as {
      snapshot: Parameters<typeof verifySnapshot>[0];
      signature: Parameters<typeof verifySnapshot>[1];
    };
    httpExport = join(dir, 'http-export.json');
    httpSig = join(dir, 'http-export.sig');
    writeFileSync(httpExport, JSON.stringify(bundle.snapshot, null, 2) + '\n', 'utf8');
    writeFileSync(httpSig, JSON.stringify(bundle.signature, null, 2) + '\n', 'utf8');

    await started.close(); // server is dead from here on
  });

  afterAll(() => {
    indexer.close();
    rmDir(dir);
  });

  it('indexer query answers subject scores offline after the server died', () => {
    const out = runCli(['query', httpExport, '--subject', 'agent_seller']);
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { verified: string; agent_id: string; score: number; receipt_count: number };
    expect(parsed.verified).toBe('valid');
    expect(parsed.agent_id).toBe('agent_seller');
    expect(parsed.score).toBe(expectedSellerScore);
    expect(parsed.receipt_count).toBe(1);

    const buyer = runCli(['query', httpExport, '--subject', 'agent_buyer']);
    expect(JSON.parse(buyer.stdout) as { score: number }).toMatchObject({ score: expectedBuyerScore });
  });

  it('snapshot signature verification passes (verifySnapshot)', () => {
    const snapshot = parseSnapshot(readFileSync(httpExport, 'utf8'));
    const signature = JSON.parse(readFileSync(httpSig, 'utf8')) as Parameters<typeof verifySnapshot>[1];
    expect(verifySnapshot(snapshot, signature)).toBe('valid');
  });

  it('a tampered snapshot fails verification and the CLI refuses to answer', () => {
    const tamperedPath = join(dir, 'tampered.json');
    const snapshot = parseSnapshot(readFileSync(httpExport, 'utf8'));
    snapshot.body.subjects[0]!.score += 999;
    writeFileSync(tamperedPath, JSON.stringify(snapshot, null, 2), 'utf8');
    // signature file is the original → body_hash mismatch
    const loose = runCli(['query', tamperedPath, '--subject', 'agent_seller', '--sig', httpSig]);
    expect(loose.exitCode).not.toBe(0);
    expect(loose.stderr).toMatch(/FAILED/);
  });

  it('CLI export → CLI query works with no server at all (offline round trip)', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'idx-export-cli-'));
    const indexer2 = new Indexer({ dir: dir2, weights: defaultWeights(), indexerId: 'demo-indexer' });
    indexer2.addTrusted('agent_buyer', buyerSeed);
    indexer2.addTrusted('agent_seller', sellerSeed);
    for (const receipt of buildReceiptSet()) {
      await indexer2.submitReceipt(structuredClone(receipt));
    }
    indexer2.close();

    const output = join(dir2, 'receipts-index.json');
    const exported = runCli(['export', '--output', output, '--store', dir2]);
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain('detached signature written');

    const sigPath = output.slice(0, -'.json'.length) + '.sig';
    expect(existsSync(sigPath)).toBe(true);

    const answered = runCli(['query', output, '--subject', 'agent_seller']);
    expect(answered.exitCode).toBe(0);
    expect(JSON.parse(answered.stdout) as { verified: string; score: number }).toMatchObject({
      verified: 'valid',
      score: expectedSellerScore,
    });

    const snapshot = parseSnapshot(readFileSync(output, 'utf8'));
    const signature = JSON.parse(readFileSync(sigPath, 'utf8')) as Parameters<typeof verifySnapshot>[1];
    expect(verifySnapshot(snapshot, signature)).toBe('valid');
    rmDir(dir2);
  });
});
