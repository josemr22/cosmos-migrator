import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlan, serializePlan } from './model.js';

const execFileAsync = promisify(execFile);
let temporaryDirectory = '';

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = '';
});

describe('run command gates', () => {
  it('runs dry-run without credentials and reports that it made no writes', async () => {
    const planPath = await writePlan();
    const result = await runCli(['run', '--plan', planPath, '--dry-run']);
    expect(result.stdout).toContain('No Cosmos DB resources or items were written.');
    expect(result.stdout).toContain('"containers": 0');
  });

  it('does not create checkpoint state for dry-run and reports status without credentials', async () => {
    const planPath = await writePlan();
    const checkpointDirectory = join(temporaryDirectory, 'checkpoints');
    const result = await runCli(['run', '--plan', planPath, '--dry-run', '--checkpoint-dir', checkpointDirectory]);
    expect(result.stdout).toContain('No Cosmos DB resources or items were written.');
    await expect(access(checkpointDirectory)).rejects.toThrow();
    const status = await runCli(['status', '--plan', planPath, '--checkpoint-dir', checkpointDirectory]);
    expect(status.stdout).toContain('No checkpoint found');
  });

  it('requires explicit noninteractive confirmation before any Cosmos connection', async () => {
    const planPath = await writePlan();
    await expect(runCli(['run', '--plan', planPath], {
      COSMOS_SOURCE_KEY: 'test-source-key', COSMOS_TARGET_KEY: 'test-target-key',
    })).rejects.toMatchObject({ stderr: expect.stringContaining('Use --yes to explicitly confirm automation') });
  });
});

async function writePlan(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'cosmos-migrator-'));
  const plan = createPlan({
    sourceEndpoint: 'https://source.documents.azure.com',
    targetEndpoint: 'https://target.documents.azure.com',
    databaseId: 'sample', containers: [], inventoryComplete: false,
  });
  const path = join(temporaryDirectory, 'plan.json');
  await writeFile(path, serializePlan(plan));
  return path;
}

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, COSMOS_SOURCE_KEY: undefined, COSMOS_TARGET_KEY: undefined, ...extraEnv };
  return execFileAsync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), ...args], { env });
}
