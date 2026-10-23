import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import type { MigrationPlan } from './model.js';

const checkpointSchema = z.object({
  schemaVersion: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  identity: z.object({ sourceEndpoint: z.string().url(), targetEndpoint: z.string().url(), databaseId: z.string().min(1) }).strict(),
  completedContainerIds: z.array(z.string().min(1)),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: z.enum(['running', 'failed']),
}).strict();

export type MigrationCheckpoint = z.infer<typeof checkpointSchema>;

export function planFingerprint(plan: MigrationPlan): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}

export function makeCheckpoint(plan: MigrationPlan, completedContainerIds: string[] = [], previous?: MigrationCheckpoint, status: 'running' | 'failed' = 'running'): MigrationCheckpoint {
  const timestamp = new Date().toISOString();
  return checkpointSchema.parse({
    schemaVersion: 1,
    fingerprint: planFingerprint(plan),
    identity: { sourceEndpoint: plan.source.endpoint, targetEndpoint: plan.target.endpoint, databaseId: plan.databaseId },
    completedContainerIds: [...new Set(completedContainerIds)],
    startedAt: previous?.startedAt ?? timestamp,
    updatedAt: timestamp,
    status,
  });
}

export function validateCheckpoint(value: unknown, plan: MigrationPlan): MigrationCheckpoint {
  const result = checkpointSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid checkpoint: ${result.error.issues[0]?.message ?? 'schema mismatch'}`);
  const checkpoint = result.data;
  const identity = { sourceEndpoint: plan.source.endpoint, targetEndpoint: plan.target.endpoint, databaseId: plan.databaseId };
  if (canonicalJson(checkpoint.identity) !== canonicalJson(identity)) throw new Error('Checkpoint identity does not match this plan.');
  if (checkpoint.fingerprint !== planFingerprint(plan)) throw new Error('Checkpoint fingerprint does not match this plan.');
  const plannedIds = new Set(plan.containers.map(({ id }) => id));
  if (checkpoint.completedContainerIds.some((id) => !plannedIds.has(id))) throw new Error('Checkpoint contains an unexpected completed container.');
  if (new Set(checkpoint.completedContainerIds).size !== checkpoint.completedContainerIds.length) throw new Error('Checkpoint contains duplicate completed containers.');
  return checkpoint;
}

export function resolveCheckpointDirectory(directory?: string): string {
  const selected = directory ?? join(process.cwd(), '.cosmos-migrator', 'checkpoints');
  if (!selected.trim()) throw new Error('Checkpoint directory must be a concrete path.');
  const absolute = resolve(selected);
  if (absolute === parse(absolute).root || absolute === tmpdir()) throw new Error('Checkpoint directory must not be a filesystem root or temporary root.');
  return absolute;
}

export function checkpointPath(directory: string, plan: MigrationPlan): string {
  const identity = canonicalJson({ source: plan.source.endpoint.toLowerCase(), target: plan.target.endpoint.toLowerCase(), databaseId: plan.databaseId });
  return join(directory, `${createHash('sha256').update(identity).digest('hex')}.checkpoint.json`);
}

export async function loadCheckpoint(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) {
    if (isNotFound(error)) return undefined;
    if (error instanceof SyntaxError) throw new Error('Checkpoint file is not valid JSON.');
    throw error;
  }
}

export async function saveCheckpoint(path: string, checkpoint: MigrationCheckpoint): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Checkpoint path parent must be a real directory, not a symbolic link.');
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function removeCheckpoint(path: string): Promise<void> {
  await rm(path, { force: true });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
