import { z } from 'zod';

export const PlatformSettingsSchema = z.object({
  accessMode: z.enum(['full_access', 'requires_approval']),
  repairAttempts: z.number().int().min(0).max(10),
  publishRunBranches: z.boolean(),
}).strict();

export const UpdateSettingsSchema = PlatformSettingsSchema.partial().refine(
  (settings) => Object.keys(settings).length > 0,
  { message: 'Provide at least one setting to update' },
);

export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;
export type AccessMode = PlatformSettings['accessMode'];

