import { describe, expect, it, vi } from 'vitest';
import { migrate, requireConfirmation, type MigrationPort } from './migration.js';
import { createPlan, type ContainerMetadata, type MigrationPlan } from './model.js';
import { resolvePartitionKey } from './cosmos-migration.js';

const container: ContainerMetadata = { id: 'orders', partitionKey: { paths: ['/tenant/id'] } };
const plan: MigrationPlan = createPlan({
  sourceEndpoint: 'https://source.documents.azure.com',
  targetEndpoint: 'https://target.documents.azure.com',
  databaseId: 'shop', containers: [container],
});

function fakePort(overrides: Partial<MigrationPort> = {}): MigrationPort {
  return {
    inspectSource: vi.fn(async () => [container]),
    inspectTarget: vi.fn(async () => ({ databaseExists: false, containers: [] })),
    createDatabase: vi.fn(async () => undefined),
    createContainer: vi.fn(async () => undefined),
    copyItems: vi.fn(async (_plan, _container, _pageSize, onPage) => { onPage(2); onPage(1); return 3; }),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('migration', () => {
  it('preflights conflicts before creating any destination resource', async () => {
    const port = fakePort({ inspectTarget: vi.fn(async () => ({ databaseExists: false, containers: [container] })) });
    await expect(migrate(plan, port, { pageSize: 50, maxConcurrency: 1 })).rejects.toThrow('container orders');
    expect(port.createDatabase).not.toHaveBeenCalled();
    expect(port.createContainer).not.toHaveBeenCalled();
    expect(port.copyItems).not.toHaveBeenCalled();
  });

  it('creates resources then copies pages and reports cumulative progress', async () => {
    const port = fakePort();
    const onProgress = vi.fn();
    await expect(migrate(plan, port, { pageSize: 7, maxConcurrency: 1, onProgress })).resolves.toBe(3);
    expect(port.createDatabase).toHaveBeenCalledWith('shop');
    expect(port.createContainer).toHaveBeenCalledWith('shop', container);
    expect(port.copyItems).toHaveBeenCalledWith(plan, container, 7, expect.any(Function));
    expect(onProgress).toHaveBeenNthCalledWith(1, 'orders', 2, 2);
    expect(onProgress).toHaveBeenNthCalledWith(2, 'orders', 3, 3);
  });

  it('requires explicit confirmation before callers construct the migration adapter', () => {
    expect(() => requireConfirmation(false)).toThrow('No Cosmos DB requests were made');
    expect(() => requireConfirmation(true)).not.toThrow();
  });

  it('resolves simple and hierarchical partition key paths from item data', () => {
    const item = { tenant: { id: 't-1' }, region: 'west' };
    expect(resolvePartitionKey(item, ['/region'])).toBe('west');
    expect(resolvePartitionKey(item, ['/tenant/id', '/region'])).toEqual(['t-1', 'west']);
  });

  it('rejects incomplete offline plans before making any destination write', async () => {
    const offlinePlan = createPlan({
      sourceEndpoint: plan.source.endpoint, targetEndpoint: plan.target.endpoint,
      databaseId: plan.databaseId, containers: [], inventoryComplete: false,
    });
    const port = fakePort();
    await expect(migrate(offlinePlan, port, { pageSize: 50, maxConcurrency: 1 })).rejects.toThrow('created offline');
    expect(port.inspectSource).not.toHaveBeenCalled();
    expect(port.createDatabase).not.toHaveBeenCalled();
  });

  it('resumes only incomplete containers after verifying the existing destination', async () => {
    const second: ContainerMetadata = { id: 'customers', partitionKey: { paths: ['/id'] } };
    const multiPlan = createPlan({ sourceEndpoint: plan.source.endpoint, targetEndpoint: plan.target.endpoint, databaseId: plan.databaseId, containers: [container, second] });
    const port = fakePort({
      inspectSource: vi.fn(async () => [container, second]),
      inspectTarget: vi.fn(async () => ({ databaseExists: true, containers: [container, second] })),
    });
    await migrate(multiPlan, port, { pageSize: 20, maxConcurrency: 1, resumeCompletedContainerIds: ['orders'] });
    expect(port.createDatabase).not.toHaveBeenCalled();
    expect(port.createContainer).not.toHaveBeenCalled();
    expect(port.copyItems).toHaveBeenCalledTimes(1);
    expect(port.copyItems).toHaveBeenCalledWith(multiPlan, second, 20, expect.any(Function));
  });

  it('refuses a mismatched resume destination before copying', async () => {
    const port = fakePort({ inspectTarget: vi.fn(async () => ({ databaseExists: true, containers: [] })) });
    await expect(migrate(plan, port, { pageSize: 20, maxConcurrency: 1, resumeCompletedContainerIds: [] })).rejects.toThrow('destination containers do not match');
    expect(port.copyItems).not.toHaveBeenCalled();
  });

  it('retains completed container progress after interruption and resumes the remainder', async () => {
    const second: ContainerMetadata = { id: 'customers', partitionKey: { paths: ['/id'] } };
    const multiPlan = createPlan({ sourceEndpoint: plan.source.endpoint, targetEndpoint: plan.target.endpoint, databaseId: plan.databaseId, containers: [container, second] });
    const completed: string[] = [];
    const hooks = {
      onStarted: vi.fn(async () => undefined),
      onContainerCompleted: vi.fn(async (id: string) => { completed.push(id); }),
      onFailed: vi.fn(async () => undefined),
      onSuccess: vi.fn(async () => undefined),
    };
    const interrupted = fakePort({
      inspectSource: vi.fn(async () => [container, second]),
      copyItems: vi.fn(async (_plan, metadata) => {
        if (metadata.id === 'customers') throw new Error('temporary copy failure');
        return 2;
      }),
    });
    await expect(migrate(multiPlan, interrupted, { pageSize: 10, maxConcurrency: 1, checkpoint: hooks })).rejects.toThrow('Migration failed after destination writes');
    expect(completed).toEqual(['orders']);
    expect(hooks.onFailed).toHaveBeenCalledOnce();

    const resumed = fakePort({
      inspectSource: vi.fn(async () => [container, second]),
      inspectTarget: vi.fn(async () => ({ databaseExists: true, containers: [container, second] })),
    });
    await migrate(multiPlan, resumed, { pageSize: 10, maxConcurrency: 1, resumeCompletedContainerIds: completed });
    expect(resumed.copyItems).toHaveBeenCalledTimes(1);
    expect(resumed.copyItems).toHaveBeenCalledWith(multiPlan, second, 10, expect.any(Function));
  });
});
