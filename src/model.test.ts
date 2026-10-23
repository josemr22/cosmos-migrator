import { describe, expect, it, vi } from 'vitest';
import { createPlan, parsePlan, serializePlan, validatePlanInput, type InventoryPort } from './model.js';
import { makePlan, renderDryRun } from './service.js';

const endpoints = { sourceEndpoint: 'https://source.documents.azure.com', targetEndpoint: 'https://target.documents.azure.com', databaseId: 'store' };

describe('plan validation', () => {
  it('rejects identical account endpoints regardless of trailing slash or case', () => {
    expect(() => validatePlanInput({ ...endpoints, targetEndpoint: 'https://SOURCE.documents.azure.com/' })).toThrow('must differ');
  });

  it('rejects an empty database id', () => {
    expect(() => validatePlanInput({ ...endpoints, databaseId: '  ' })).toThrow();
  });
});

describe('plan serialization', () => {
  it('round trips versioned container metadata without credential or item data', () => {
    const plan = createPlan({ ...endpoints, containers: [{ id: 'orders', partitionKey: { paths: ['/tenantId'], kind: 'Hash', version: 2 } }], createdAt: new Date('2026-01-02T03:04:05.000Z') });
    const json = serializePlan(plan);
    expect(parsePlan(json)).toEqual(plan);
    expect(json).toContain('"schemaVersion": 1');
    expect(json).not.toMatch(/"key"|"secret"|"items"|COSMOS_SOURCE_KEY|should-not-serialize/i);
  });

  it('rejects unexpected plan properties that could contain secrets or item data', () => {
    const plan = { ...createPlan({ ...endpoints, containers: [] }), credentials: { key: 'should-not-serialize' } };
    expect(() => parsePlan(JSON.stringify(plan))).toThrow('Invalid plan file');
  });
});

describe('offline planning behavior', () => {
  it('never calls the inventory port and returns no containers', async () => {
    const inventory: InventoryPort = { listContainers: vi.fn() };
    const plan = await makePlan({ ...endpoints, offline: true }, inventory);
    expect(plan.containers).toEqual([]);
    expect(inventory.listContainers).not.toHaveBeenCalled();
  });

  it('renders a preview explicitly stating that no writes occurred', () => {
    const preview = renderDryRun(createPlan({ ...endpoints, containers: [] }));
    expect(preview).toContain('No Cosmos DB resources or items were written');
    expect(preview).toContain('"containers": 0');
  });

  it('requires source credentials only when connecting for read-only inventory', async () => {
    const inventory: InventoryPort = { listContainers: vi.fn() };
    await expect(makePlan({ ...endpoints, offline: false }, inventory)).rejects.toThrow('COSMOS_SOURCE_KEY');
    expect(inventory.listContainers).not.toHaveBeenCalled();
  });
});
