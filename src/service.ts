import { createPlan, type InventoryPort, type MigrationPlan } from './model.js';

export interface PlanOptions {
  sourceEndpoint: string;
  targetEndpoint: string;
  databaseId: string;
  offline: boolean;
  sourceKey?: string;
}

export async function makePlan(options: PlanOptions, inventory: InventoryPort): Promise<MigrationPlan> {
  const containers = options.offline
    ? []
    : await inventory.listContainers(options.sourceEndpoint, requiredSecret(options.sourceKey, 'COSMOS_SOURCE_KEY'), options.databaseId);
  return createPlan({
    sourceEndpoint: options.sourceEndpoint,
    targetEndpoint: options.targetEndpoint,
    databaseId: options.databaseId,
    containers,
    inventoryComplete: !options.offline,
  });
}

export function renderDryRun(plan: MigrationPlan): string {
  return `Dry run only. No Cosmos DB resources or items were written.\n${JSON.stringify({
    database: plan.databaseId,
    source: plan.source.endpoint,
    target: plan.target.endpoint,
    containers: plan.containers.length,
  }, null, 2)}\n`;
}

function requiredSecret(value: string | undefined, variableName: string): string {
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${variableName}.`);
  return value;
}
