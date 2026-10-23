import { CosmosClient } from '@azure/cosmos';
import type { ContainerMetadata, InventoryPort } from './model.js';

export class CosmosInventory implements InventoryPort {
  async listContainers(endpoint: string, key: string, databaseId: string): Promise<ContainerMetadata[]> {
    const client = new CosmosClient({ endpoint, key });
    try {
      const { resources } = await client.database(databaseId).containers.readAll().fetchAll();
      return resources.map((container) => {
        const definition = container as typeof container & { analyticalStorageTtl?: number | null };
        return {
          id: container.id,
          partitionKey: {
            paths: container.partitionKey?.paths ?? [],
            ...(container.partitionKey?.kind ? { kind: container.partitionKey.kind } : {}),
            ...(container.partitionKey?.version ? { version: container.partitionKey.version } : {}),
          },
          ...(container.indexingPolicy ? { indexingPolicy: container.indexingPolicy as unknown as Record<string, unknown> } : {}),
          ...(container.uniqueKeyPolicy ? { uniqueKeyPolicy: container.uniqueKeyPolicy as unknown as Record<string, unknown> } : {}),
          ...(container.defaultTtl !== undefined ? { defaultTtl: container.defaultTtl } : {}),
          ...(definition.analyticalStorageTtl !== undefined ? { analyticalStorageTtl: definition.analyticalStorageTtl } : {}),
        };
      });
    } finally {
      await client.dispose();
    }
  }
}
