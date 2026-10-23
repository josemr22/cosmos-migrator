#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { CosmosInventory } from './cosmos-inventory.js';
import { migrationPlanSchema, parsePlan, serializePlan } from './model.js';
import { makePlan, renderDryRun } from './service.js';
import { CosmosMigration } from './cosmos-migration.js';
import { migrate, requireConfirmation } from './migration.js';
import {
  checkpointPath, loadCheckpoint, makeCheckpoint, removeCheckpoint,
  resolveCheckpointDirectory, saveCheckpoint, validateCheckpoint,
} from './checkpoint.js';

const program = new Command();
const inventory = new CosmosInventory();

program
  .name('cosmos-migrator')
  .description('Plan and run Cosmos DB migrations.')
  .showHelpAfterError();

program.command('plan')
  .description('Create a read-only migration plan.')
  .requiredOption('--source-endpoint <url>', 'Source Cosmos DB account endpoint', parseEndpoint)
  .requiredOption('--target-endpoint <url>', 'Target Cosmos DB account endpoint', parseEndpoint)
  .requiredOption('--database <id>', 'Database id to inspect', parseDatabase)
  .option('--offline', 'Create a plan with an empty container inventory; no Azure connection is made.')
  .option('--plan-out <file>', 'Optionally save the plan JSON to this path.')
  .action(async (options: { sourceEndpoint: string; targetEndpoint: string; database: string; offline?: boolean; planOut?: string }) => {
    assertDistinctEndpoints(options.sourceEndpoint, options.targetEndpoint);
    const plan = await makePlan({
      sourceEndpoint: options.sourceEndpoint,
      targetEndpoint: options.targetEndpoint,
      databaseId: options.database,
      offline: Boolean(options.offline),
      sourceKey: process.env.COSMOS_SOURCE_KEY,
    }, inventory);
    const serialized = serializePlan(plan);
    if (options.planOut) await writeFile(options.planOut, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    process.stdout.write(serialized);
    if (options.planOut) process.stderr.write(`Plan saved to ${options.planOut}\n`);
  });

program.command('run')
  .description('Run or preview a saved migration plan.')
  .requiredOption('--plan <file>', 'Path to a saved plan JSON')
  .option('--dry-run', 'Validate and display the plan without writing to Cosmos DB.')
  .option('--yes', 'Confirm migration without an interactive prompt.')
  .option('--checkpoint-dir <directory>', 'Directory for migration recovery checkpoints (defaults to ./.cosmos-migrator/checkpoints).')
  .option('--page-size <n>', 'Maximum items requested per source page (1-1000).', parseBoundedInteger(1, 1000), 100)
  .option('--max-concurrency <n>', 'Validated concurrency setting (1-16); execution is currently sequential.', parseBoundedInteger(1, 16), 1)
  .action(async (options: { plan: string; dryRun?: boolean; yes?: boolean; checkpointDir?: string; pageSize: number; maxConcurrency: number }) => {
    const contents = await readFile(options.plan, 'utf8');
    const plan = parsePlan(contents);
    migrationPlanSchema.parse(plan);
    if (options.dryRun) {
      process.stdout.write(renderDryRun(plan));
      return;
    }
    const sourceKey = requiredSecret(process.env.COSMOS_SOURCE_KEY, 'COSMOS_SOURCE_KEY');
    const targetKey = requiredSecret(process.env.COSMOS_TARGET_KEY, 'COSMOS_TARGET_KEY');
    if (!options.yes) requireConfirmation(await confirmMigration(plan.databaseId, plan.containers.length));
    else requireConfirmation(true);
    const directory = resolveCheckpointDirectory(options.checkpointDir);
    const path = checkpointPath(directory, plan);
    let checkpoint = makeCheckpoint(plan);
    const checkpointHooks = {
      onStarted: async () => { await saveCheckpoint(path, checkpoint); },
      onContainerCompleted: async (containerId: string) => {
        checkpoint = makeCheckpoint(plan, [...checkpoint.completedContainerIds, containerId], checkpoint);
        await saveCheckpoint(path, checkpoint);
      },
      onFailed: async () => {
        checkpoint = makeCheckpoint(plan, checkpoint.completedContainerIds, checkpoint, 'failed');
        await saveCheckpoint(path, checkpoint);
        process.stderr.write(`Recovery checkpoint retained at ${path}\n`);
      },
      onSuccess: async () => { await removeCheckpoint(path); },
    };
    const port = new CosmosMigration(plan, sourceKey, targetKey);
    const count = await migrate(plan, port, {
      pageSize: options.pageSize,
      maxConcurrency: options.maxConcurrency,
      checkpoint: checkpointHooks,
      onProgress: (containerId, copied, total) => process.stderr.write(`${containerId}: ${copied} copied; ${total} copied across all containers\n`),
    });
    process.stdout.write(`Migration completed. Items copied: ${count}.\n`);
  });

program.command('resume')
  .description('Resume a failed migration from its validated checkpoint.')
  .requiredOption('--plan <file>', 'Path to the saved migration plan')
  .option('--checkpoint-dir <directory>', 'Checkpoint directory; defaults to ./.cosmos-migrator/checkpoints.')
  .option('--dry-run', 'Show which containers would be copied without connecting to Cosmos DB.')
  .option('--yes', 'Confirm migration without an interactive prompt.')
  .option('--page-size <n>', 'Maximum items requested per source page (1-1000).', parseBoundedInteger(1, 1000), 100)
  .action(async (options: { plan: string; checkpointDir?: string; dryRun?: boolean; yes?: boolean; pageSize: number }) => {
    const plan = parsePlan(await readFile(options.plan, 'utf8'));
    const directory = resolveCheckpointDirectory(options.checkpointDir);
    const path = checkpointPath(directory, plan);
    const loaded = await loadCheckpoint(path);
    if (loaded === undefined) throw new Error(`No checkpoint found at ${path}.`);
    let checkpoint = validateCheckpoint(loaded, plan);
    if (options.dryRun) {
      const remaining = plan.containers.filter(({ id }) => !checkpoint.completedContainerIds.includes(id));
      process.stdout.write(`Resume preview: ${remaining.length} containers remain; no Cosmos DB requests or filesystem writes were made.\n`);
      for (const container of remaining) process.stdout.write(`  ${container.id}\n`);
      return;
    }
    const sourceKey = requiredSecret(process.env.COSMOS_SOURCE_KEY, 'COSMOS_SOURCE_KEY');
    const targetKey = requiredSecret(process.env.COSMOS_TARGET_KEY, 'COSMOS_TARGET_KEY');
    if (!options.yes) requireConfirmation(await confirmMigration(plan.databaseId, plan.containers.length - checkpoint.completedContainerIds.length));
    else requireConfirmation(true);
    const port = new CosmosMigration(plan, sourceKey, targetKey);
    const count = await migrate(plan, port, {
      pageSize: options.pageSize,
      maxConcurrency: 1,
      resumeCompletedContainerIds: checkpoint.completedContainerIds,
      checkpoint: {
        onStarted: async () => undefined,
        onContainerCompleted: async (containerId) => {
          checkpoint = makeCheckpoint(plan, [...checkpoint.completedContainerIds, containerId], checkpoint);
          await saveCheckpoint(path, checkpoint);
        },
        onFailed: async () => {
          checkpoint = makeCheckpoint(plan, checkpoint.completedContainerIds, checkpoint, 'failed');
          await saveCheckpoint(path, checkpoint);
          process.stderr.write(`Recovery checkpoint retained at ${path}\n`);
        },
        onSuccess: async () => { await removeCheckpoint(path); },
      },
    });
    process.stdout.write(`Migration resumed and completed. Items copied in this attempt: ${count}.\n`);
  });

program.command('status')
  .description('Inspect local checkpoint status without cloud credentials.')
  .requiredOption('--plan <file>', 'Path to the saved migration plan')
  .option('--checkpoint-dir <directory>', 'Checkpoint directory; defaults to ./.cosmos-migrator/checkpoints.')
  .action(async (options: { plan: string; checkpointDir?: string }) => {
    const plan = parsePlan(await readFile(options.plan, 'utf8'));
    const path = checkpointPath(resolveCheckpointDirectory(options.checkpointDir), plan);
    const loaded = await loadCheckpoint(path);
    if (loaded === undefined) {
      process.stdout.write(`No checkpoint found for this plan. Expected location: ${path}\n`);
      return;
    }
    const checkpoint = validateCheckpoint(loaded, plan);
    process.stdout.write(`Checkpoint: ${checkpoint.status}\nCompleted containers: ${checkpoint.completedContainerIds.length}/${plan.containers.length}\nUpdated: ${checkpoint.updatedAt}\nLocation: ${path}\n`);
  });

program.exitOverride();
try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else {
  const message = error instanceof Error ? error.message : 'Unexpected error.';
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
  }
}

function parseEndpoint(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new InvalidArgumentError('Endpoint must be a valid URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new InvalidArgumentError('Endpoint must be an https URL without embedded credentials, query, or fragment.');
  }
  return value.replace(/\/$/, '');
}

function parseDatabase(value: string): string {
  if (!value.trim()) throw new InvalidArgumentError('Database id must not be empty.');
  return value.trim();
}

function assertDistinctEndpoints(source: string, target: string): void {
  if (normalizeEndpoint(source) === normalizeEndpoint(target)) throw new Error('Source and target endpoints must differ.');
}

function normalizeEndpoint(value: string): string { return value.trim().replace(/\/$/, '').toLowerCase(); }

function parseBoundedInteger(minimum: number, maximum: number) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new InvalidArgumentError(`Value must be an integer from ${minimum} to ${maximum}.`);
    }
    return parsed;
  };
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}.`);
  return value;
}

async function confirmMigration(database: string, containers: number): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive confirmation requires a terminal. Use --yes to explicitly confirm automation.');
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(`Migrate database ${database} and ${containers} containers? This writes to Cosmos DB. Type "yes" to continue: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    readline.close();
  }
}
