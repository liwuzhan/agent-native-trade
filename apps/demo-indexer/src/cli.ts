#!/usr/bin/env node
/**
 * demo-indexer CLI (module M8).
 *
 *   indexer export --output receipts-index.json [--weights weights.json]
 *                  [--store <dir>] [--indexer-id <id>]
 *       Build the signed static snapshot; writes receipts-index.json + .sig.
 *
 *   indexer query <snapshot> [--subject <agentId>] [--sig <path>]
 *       Offline query: verify the snapshot signature and answer subject
 *       scores with no server running.
 *
 *   indexer serve --port <n> [--store <dir>] [--weights <path>] [--indexer-id <id>]
 *       Start the HTTP indexer.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { loadWeights } from './weights.js';
import { Indexer } from './indexer.js';
import { parseDetachedSignature, parseSnapshot, querySnapshot, verifySnapshot } from './snapshot.js';
import { startIndexerServer } from './server.js';

/** Resolve the packaged default weights file (works from dist/ and from src/). */
function defaultWeightsPath(): string {
  return new URL('../weights.json', import.meta.url).pathname;
}

function sigPathFor(snapshotPath: string): string {
  return snapshotPath.endsWith('.json') ? snapshotPath.slice(0, -'.json'.length) + '.sig' : snapshotPath + '.sig';
}

async function cmdExport(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: { type: 'string' },
      weights: { type: 'string' },
      store: { type: 'string', default: '.' },
      'indexer-id': { type: 'string', default: 'demo-indexer' },
    },
  });
  if (positionals.length > 0) {
    process.stderr.write(`export: unexpected positional arguments: ${positionals.join(' ')}\n`);
    return 1;
  }
  const output = values.output;
  if (output === undefined) {
    process.stderr.write('export: --output <path> is required\n');
    return 1;
  }
  const weights = loadWeights(values.weights ?? defaultWeightsPath());
  const indexer = new Indexer({ dir: values.store as string, weights, indexerId: values['indexer-id'] as string });
  try {
    const { snapshot, signature } = indexer.exportSnapshot();
    const sigPath = sigPathFor(output);
    writeFileSync(output, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    writeFileSync(sigPath, JSON.stringify(signature, null, 2) + '\n', 'utf8');
    process.stdout.write(`exported ${snapshot.body.subjects.length} subject(s) to ${output}\n`);
    process.stdout.write(`detached signature written to ${sigPath} (body_hash ${snapshot.body_hash})\n`);
    for (const subject of snapshot.body.subjects) {
      process.stdout.write(`  ${subject.agent_id}: score=${subject.score} receipts=${subject.receipt_count}\n`);
    }
    return 0;
  } finally {
    indexer.close();
  }
}

async function cmdQuery(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      subject: { type: 'string' },
      sig: { type: 'string' },
    },
  });
  const snapshotPath = positionals[0];
  if (snapshotPath === undefined) {
    process.stderr.write('query: <snapshot> path is required\n');
    return 1;
  }
  const sigPath = values.sig ?? sigPathFor(snapshotPath);
  let snapshot;
  let signature;
  try {
    snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
    signature = parseDetachedSignature(readFileSync(sigPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`query: cannot read snapshot/signature: ${(err as Error).message}\n`);
    return 1;
  }
  const verdict = verifySnapshot(snapshot, signature);
  if (verdict !== 'valid') {
    process.stderr.write(`query: snapshot signature verification FAILED (${verdict})\n`);
    return 1;
  }
  const subjectId = values.subject;
  if (subjectId !== undefined) {
    const view = querySnapshot(snapshot, subjectId);
    if (view === undefined) {
      process.stderr.write(`query: subject ${JSON.stringify(subjectId)} not found in snapshot\n`);
      return 1;
    }
    process.stdout.write(JSON.stringify({ verified: 'valid', agent_id: view.agent_id, score: view.score, receipt_count: view.receipt_count, receipts: view.receipts }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(
    JSON.stringify(
      { verified: 'valid', generated_at: snapshot.body.generated_at, snapshot_hash: snapshot.body.snapshot_hash, subjects: snapshot.body.subjects.map((s) => ({ agent_id: s.agent_id, score: s.score, receipt_count: s.receipt_count })) },
      null,
      2,
    ) + '\n',
  );
  return 0;
}

async function cmdServe(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '8787' },
      store: { type: 'string', default: '.' },
      weights: { type: 'string' },
      'indexer-id': { type: 'string', default: 'demo-indexer' },
    },
  });
  if (positionals.length > 0) {
    process.stderr.write(`serve: unexpected positional arguments: ${positionals.join(' ')}\n`);
    return 1;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`serve: invalid --port ${JSON.stringify(values.port)}\n`);
    return 1;
  }
  const weights = loadWeights(values.weights ?? defaultWeightsPath());
  const indexer = new Indexer({ dir: values.store as string, weights, indexerId: values['indexer-id'] as string });
  const started = await startIndexerServer(indexer, port);
  process.stdout.write(`demo-indexer listening on http://127.0.0.1:${started.port}\n`);
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      started.close().then(() => {
        indexer.close();
        resolve();
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);
  switch (command) {
    case 'export':
      return cmdExport(rest);
    case 'query':
      return cmdQuery(rest);
    case 'serve':
      return cmdServe(rest);
    case undefined:
      process.stderr.write('usage: indexer <export|query|serve> ...\n');
      return 1;
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      return 1;
  }
}

const code = await main();
if (code !== 0) process.exitCode = code;
