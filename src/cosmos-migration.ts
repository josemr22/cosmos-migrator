import { CosmosClient, type ContainerDefinition, type PartitionKey, type RequestOptions } from '@azure/cosmos';
import type { ContainerMetadata, MigrationPlan } from './model.js';
import type { MigrationPort } from './migration.js';
import { CosmosInventory } from './cosmos-inventory.js';

export class CosmosMigration implements MigrationPort {
  private readonly source: CosmosClient;
  private readonly target: CosmosClient;
  private readonly inventory = new CosmosInventory();
  private readonly sourceKey: string;

  constructor(plan: MigrationPlan, sourceKey: string, targetKey: string) {
    this.source = new CosmosClient({ endpoint: plan.source.endpoint, key: sourceKey });
    this.target = new CosmosClient({ endpoint: plan.target.endpoint, key: targetKey });
    this.sourceKey = sourceKey;
  }

  inspectSource(plan: MigrationPlan): Promise<ContainerMetadata[]> {
    return this.inventory.listContainers(plan.source.endpoint, this.sourceKey, plan.databaseId);
  }

  async inspectTarget(plan: MigrationPlan): Promise<{ databaseExists: boolean; containers: ContainerMetadata[] }> {
    const database = this.target.database(plan.databaseId);
    try {
      await database.read();
      const { resources } = await database.containers.readAll().fetchAll();
      return { databaseExists: true, containers: resources.map((container) => metadataFromContainer(container)) };
    } catch (error) {
      if (isNotFound(error)) return { databaseExists: false, containers: [] };
      throw error;
    }
  }

  async createDatabase(databaseId: string): Promise<void> {
    await this.target.databases.create({ id: databaseId });
  }

  async createContainer(databaseId: string, metadata: ContainerMetadata): Promise<void> {
    const definition: ContainerDefinition = {
      id: metadata.id,
      partitionKey: {
        paths: metadata.partitionKey.paths,
        ...(metadata.partitionKey.kind ? { kind: metadata.partitionKey.kind as NonNullable<ContainerDefinition['partitionKey']>['kind'] } : {}),
        ...(metadata.partitionKey.version ? { version: metadata.partitionKey.version as 1 | 2 } : {}),
      },
      ...(metadata.indexingPolicy ? { indexingPolicy: metadata.indexingPolicy as ContainerDefinition['indexingPolicy'] } : {}),
      ...(metadata.uniqueKeyPolicy ? { uniqueKeyPolicy: metadata.uniqueKeyPolicy as unknown as ContainerDefinition['uniqueKeyPolicy'] } : {}),
      ...(metadata.defaultTtl !== undefined && metadata.defaultTtl !== null ? { defaultTtl: metadata.defaultTtl } : {}),
    };
    await this.target.database(databaseId).containers.create(definition);
  }

  async copyItems(plan: MigrationPlan, metadata: ContainerMetadata, pageSize: number, onPage: (count: number) => void): Promise<number> {
    const source = this.source.database(plan.databaseId).container(metadata.id);
    const target = this.target.database(plan.databaseId).container(metadata.id);
    const iterator = source.items.query('SELECT * FROM c', { maxItemCount: pageSize });
    let copied = 0;
    while (iterator.hasMoreResults()) {
      const { resources } = await iterator.fetchNext();
      for (const item of resources) {
        await target.items.upsert(item, { partitionKey: resolvePartitionKey(item, metadata.partitionKey.paths) as PartitionKey } as RequestOptions & { partitionKey: PartitionKey });
        copied++;
      }
      onPage(resources.length);
    }
    return copied;
  }

  async close(): Promise<void> {
    await Promise.all([this.source.dispose(), this.target.dispose()]);
  }

}

function metadataFromContainer(container: ContainerDefinition & { analyticalStorageTtl?: number | null }): ContainerMetadata {
  if (!container.id) throw new Error('Destination container has no id.');
  return {
    id: container.id,
    partitionKey: {
      paths: container.partitionKey?.paths ?? [],
      ...(container.partitionKey?.kind ? { kind: container.partitionKey.kind } : {}),
      ...(container.partitionKey?.version ? { version: container.partitionKey.version as 1 | 2 } : {}),
    },
    ...(container.indexingPolicy ? { indexingPolicy: container.indexingPolicy as unknown as Record<string, unknown> } : {}),
    ...(container.uniqueKeyPolicy ? { uniqueKeyPolicy: container.uniqueKeyPolicy as unknown as Record<string, unknown> } : {}),
    ...(container.defaultTtl !== undefined ? { defaultTtl: container.defaultTtl } : {}),
    ...(container.analyticalStorageTtl !== undefined ? { analyticalStorageTtl: container.analyticalStorageTtl } : {}),
  };
}

export function resolvePartitionKey(item: Record<string, unknown>, paths: string[]): unknown {
  const values = paths.map((path) => path.slice(1).split('/').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }, item));
  const normalized = values.map((value) => value === undefined ? {} : value);
  return normalized.length === 1 ? normalized[0] : normalized;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (
    (error as { code?: number | string }).code === 404 ||
    (error as { statusCode?: number }).statusCode === 404
  );
}
