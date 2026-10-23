import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkpointPath, loadCheckpoint, makeCheckpoint, planFingerprint, resolveCheckpointDirectory, saveCheckpoint, validateCheckpoint } from './checkpoint.js';
import { createPlan } from './model.js';

let temporaryDirectory = '';
afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = '';
});

function newPlan() {
  return createPlan({
    sourceEndpoint: 'https://source.documents.azure.com',
    targetEndpoint: 'https://target.documents.azure.com',
    databaseId: 'shop',
    containers: [{ id: 'orders', partitionKey: { paths: ['/tenant'] } }],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

describe('checkpoint persistence', () => {
  it('fingerprints deterministically and never serializes credentials or item data', async () => {
    const plan = newPlan();
    const equivalent = JSON.parse(JSON.stringify(plan)) as typeof plan;
    expect(planFingerprint(plan)).toBe(planFingerprint(equivalent));
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'cosmos-checkpoint-'));
    const path = checkpointPath(temporaryDirectory, plan);
    await saveCheckpoint(path, makeCheckpoint(plan));
    const contents = await readFile(path, 'utf8');
    expect(contents).not.toContain('account-key');
    expect(contents).not.toContain('item-payload');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(temporaryDirectory))).toEqual([path.split('/').at(-1)]);
  });

  it('loads checkpoint atomically and rejects a plan with changed contents', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'cosmos-checkpoint-'));
    const plan = newPlan();
    const path = checkpointPath(temporaryDirectory, plan);
    const checkpoint = makeCheckpoint(plan, ['orders']);
    await saveCheckpoint(path, checkpoint);
    expect(validateCheckpoint(await loadCheckpoint(path), plan).completedContainerIds).toEqual(['orders']);
    const changedPlan = createPlan({ sourceEndpoint: plan.source.endpoint, targetEndpoint: plan.target.endpoint, databaseId: plan.databaseId, containers: [] });
    const loaded = await loadCheckpoint(path);
    expect(() => validateCheckpoint(loaded, changedPlan)).toThrow('fingerprint');
    expect((await readdir(temporaryDirectory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('uses a local default and refuses filesystem roots', () => {
    expect(resolveCheckpointDirectory()).toContain('.cosmos-migrator/checkpoints');
    expect(() => resolveCheckpointDirectory('/')).toThrow('filesystem root');
  });
});
