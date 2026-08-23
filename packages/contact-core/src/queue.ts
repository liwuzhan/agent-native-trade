import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { InboundEvent, WakeTask } from './types.js';
import { createWakeTask } from './wake.js';

const TASK_ID_RE = /^wake_[a-f0-9]{32}$/u;

export interface EnqueueResult {
  accepted: boolean;
  task: WakeTask;
  path: string;
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) throw new Error('invalid WakeTask id');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class FileWakeQueue {
  readonly rootDir: string;
  readonly pendingDir: string;
  readonly doneDir: string;
  readonly temporaryDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.pendingDir = join(rootDir, 'pending');
    this.doneDir = join(rootDir, 'done');
    this.temporaryDir = join(rootDir, '.tmp');
  }

  async init(): Promise<void> {
    for (const dir of [this.rootDir, this.pendingDir, this.doneDir, this.temporaryDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    }
  }

  async enqueue(event: InboundEvent, now = new Date()): Promise<EnqueueResult> {
    await this.init();
    const task = createWakeTask(event, now);
    const filename = `${task.task_id}.json`;
    const pendingPath = join(this.pendingDir, filename);
    const donePath = join(this.doneDir, filename);

    if (await exists(donePath)) return { accepted: false, task, path: donePath };

    const temporaryPath = join(
      this.temporaryDir,
      `${task.task_id}.${process.pid}.${randomUUID()}.json`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(task, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporaryPath, 0o600);

    try {
      await link(temporaryPath, pendingPath);
      await chmod(pendingPath, 0o600);
      return { accepted: true, task, path: pendingPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { accepted: false, task, path: pendingPath };
      }
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async listPending(): Promise<WakeTask[]> {
    await this.init();
    const entries = (await readdir(this.pendingDir))
      .filter((entry) => TASK_ID_RE.test(entry.replace(/\.json$/u, '')) && entry.endsWith('.json'))
      .sort();
    return Promise.all(entries.map((entry) => this.readTask(join(this.pendingDir, entry))));
  }

  async get(taskId: string): Promise<WakeTask | undefined> {
    assertTaskId(taskId);
    await this.init();
    const pendingPath = join(this.pendingDir, `${taskId}.json`);
    if (await exists(pendingPath)) return this.readTask(pendingPath);
    const donePath = join(this.doneDir, `${taskId}.json`);
    if (await exists(donePath)) return this.readTask(donePath);
    return undefined;
  }

  async ack(taskId: string): Promise<string> {
    assertTaskId(taskId);
    await this.init();
    const pendingPath = join(this.pendingDir, `${taskId}.json`);
    const donePath = join(this.doneDir, `${taskId}.json`);
    if (await exists(donePath)) return donePath;
    await mkdir(dirname(donePath), { recursive: true, mode: 0o700 });
    await rename(pendingPath, donePath);
    return donePath;
  }

  private async readTask(path: string): Promise<WakeTask> {
    const value = JSON.parse(await readFile(path, 'utf8')) as WakeTask;
    if (value.version !== 'agent-trade-wake-task/0.1' || !TASK_ID_RE.test(value.task_id)) {
      throw new Error(`invalid WakeTask file: ${path}`);
    }
    return value;
  }
}
