import { z } from 'zod';

export const containerMetadataSchema = z.object({
  id: z.string().min(1),
  partitionKey: z.object({
    paths: z.array(z.string().startsWith('/')).min(1),
    kind: z.enum(['Hash', 'MultiHash']).optional(),
    version: z.union([z.literal(1), z.literal(2)]).optional(),
  }),
  indexingPolicy: z.object({}).catchall(z.unknown()).optional(),
  uniqueKeyPolicy: z.object({}).catchall(z.unknown()).optional(),
  defaultTtl: z.number().int().nullable().optional(),
  analyticalStorageTtl: z.number().int().nullable().optional(),
}).strict();

export const migrationPlanSchema = z.object({
  schemaVersion: z.literal(1),
  inventoryComplete: z.boolean(),
  createdAt: z.string().datetime(),
  source: z.object({ endpoint: z.string().url() }).strict(),
  target: z.object({ endpoint: z.string().url() }).strict(),
  databaseId: z.string().min(1),
  containers: z.array(containerMetadataSchema),
}).strict().superRefine((plan, context) => {
  if (normalizeEndpoint(plan.source.endpoint) === normalizeEndpoint(plan.target.endpoint)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Source and target endpoints must differ.' });
  }
  const ids = plan.containers.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Plan contains duplicate container ids.' });
  }
  for (const container of plan.containers) {
    if (new Set(container.partitionKey.paths).size !== container.partitionKey.paths.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Container ${container.id} has duplicate partition key paths.` });
    }
  }
});

export type ContainerMetadata = z.infer<typeof containerMetadataSchema>;
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;

export interface InventoryPort {
  listContainers(endpoint: string, key: string, databaseId: string): Promise<ContainerMetadata[]>;
}

export interface PlanInput {
  sourceEndpoint: string;
  targetEndpoint: string;
  databaseId: string;
  containers: ContainerMetadata[];
  inventoryComplete?: boolean;
  createdAt?: Date;
}

export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/$/, '').toLowerCase();
}

export function validatePlanInput(input: Omit<PlanInput, 'containers' | 'createdAt'>): void {
  const parsed = z.object({
    sourceEndpoint: z.string().url(),
    targetEndpoint: z.string().url(),
    databaseId: z.string().trim().min(1),
  }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid plan input.');
  if (normalizeEndpoint(input.sourceEndpoint) === normalizeEndpoint(input.targetEndpoint)) {
    throw new Error('Source and target endpoints must differ.');
  }
}

export function createPlan(input: PlanInput): MigrationPlan {
  validatePlanInput(input);
  return migrationPlanSchema.parse({
    schemaVersion: 1,
    inventoryComplete: input.inventoryComplete ?? true,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    source: { endpoint: input.sourceEndpoint.trim() },
    target: { endpoint: input.targetEndpoint.trim() },
    databaseId: input.databaseId.trim(),
    containers: input.containers,
  });
}

export function parsePlan(serialized: string): MigrationPlan {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Plan file is not valid JSON.');
  }
  const result = migrationPlanSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid plan file: ${result.error.issues[0]?.message ?? 'schema mismatch'}`);
  return result.data;
}

export function serializePlan(plan: MigrationPlan): string {
  return `${JSON.stringify(migrationPlanSchema.parse(plan), null, 2)}\n`;
}
