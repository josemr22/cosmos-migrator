import type { ContainerMetadata, MigrationPlan } from './model.js';

export interface MigrationOptions {
  pageSize: number;
  maxConcurrency: number;
  onProgress?: (containerId: string, copied: number, total: number) => void;
  resumeCompletedContainerIds?: string[];
  checkpoint?: {
    onStarted(): Promise<void>;
    onContainerCompleted(containerId: string): Promise<void>;
    onFailed(): Promise<void>;
    onSuccess(): Promise<void>;
  };
}

export interface MigrationPort {
  inspectSource(plan: MigrationPlan): Promise<ContainerMetadata[]>;
  inspectTarget(plan: MigrationPlan): Promise<{ databaseExists: boolean; containers: ContainerMetadata[] }>;
  createDatabase(databaseId: string): Promise<void>;
  createContainer(databaseId: string, definition: ContainerMetadata): Promise<void>;
  copyItems(plan: MigrationPlan, container: ContainerMetadata, pageSize: number, onPage: (count: number) => void): Promise<number>;
  close(): Promise<void>;
}

export async function migrate(plan: MigrationPlan, port: MigrationPort, options: MigrationOptions): Promise<number> {
  validateOptions(options);
  let writesStarted = false;
  try {
    if (!plan.inventoryComplete) throw new Error('This plan was created offline and has no complete source inventory. Create a new online plan before running migration.');
    const [source, target] = await Promise.all([port.inspectSource(plan), port.inspectTarget(plan)]);
    const sourceProblems = compareInventory(plan.containers, source);
    if (sourceProblems.length) throw new Error(`Source no longer matches the plan: ${sourceProblems.join(', ')}.`);
    const resume = options.resumeCompletedContainerIds !== undefined;
    if (resume) validateResumeDestination(plan, target);
    else validateEmptyDestination(plan, target);

    writesStarted = true;
    if (!resume) {
      await options.checkpoint?.onStarted();
      await port.createDatabase(plan.databaseId);
      for (const container of plan.containers) await port.createContainer(plan.databaseId, container);
    }
    let total = 0;
    for (const container of plan.containers) {
      if (options.resumeCompletedContainerIds?.includes(container.id)) continue;
      let containerTotal = 0;
      const copied = await port.copyItems(plan, container, options.pageSize, (count) => {
        containerTotal += count;
        options.onProgress?.(container.id, containerTotal, total + containerTotal);
      });
      total += copied;
      if (copied === 0) options.onProgress?.(container.id, 0, total);
      await options.checkpoint?.onContainerCompleted(container.id);
    }
    await options.checkpoint?.onSuccess();
    return total;
  } catch (error) {
    if (writesStarted) {
      await options.checkpoint?.onFailed().catch(() => undefined);
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`Migration failed after destination writes may have begun. No automatic cleanup was performed. ${detail}`);
    }
    throw error;
  } finally {
    await port.close();
  }
}

function validateEmptyDestination(plan: MigrationPlan, target: { databaseExists: boolean; containers: ContainerMetadata[] }): void {
  const conflicts = [
    ...(target.databaseExists ? [`database ${plan.databaseId}`] : []),
    ...target.containers.map(({ id }) => `container ${id}`),
  ];
  if (conflicts.length) throw new Error(`Destination resources already exist: ${conflicts.join(', ')}. No writes were made.`);
}

function validateResumeDestination(plan: MigrationPlan, target: { databaseExists: boolean; containers: ContainerMetadata[] }): void {
  if (!target.databaseExists) throw new Error('Cannot resume: destination database is missing. No writes were made.');
  const issues = compareInventory(plan.containers, target.containers);
  if (issues.length) throw new Error(`Cannot resume: destination containers do not match the plan: ${issues.join(', ')}. No writes were made.`);
}

export function validateOptions(options: MigrationOptions): void {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000) {
    throw new Error('--page-size must be an integer from 1 to 1000.');
  }
  if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 16) {
    throw new Error('--max-concurrency must be an integer from 1 to 16.');
  }
}

export function requireConfirmation(confirmed: boolean): void {
  if (!confirmed) throw new Error('Migration was not confirmed. No Cosmos DB requests were made.');
}

function compareInventory(expected: ContainerMetadata[], actual: ContainerMetadata[]): string[] {
  const normalize = (items: ContainerMetadata[]) => new Map(items.map((item) => [item.id, canonicalJson(item)]));
  const expectedMap = normalize(expected);
  const actualMap = normalize(actual);
  const issues: string[] = [];
  for (const [id, metadata] of expectedMap) {
    if (actualMap.get(id) !== metadata) issues.push(id);
  }
  for (const id of actualMap.keys()) if (!expectedMap.has(id)) issues.push(`${id} (new)`);
  return issues;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
