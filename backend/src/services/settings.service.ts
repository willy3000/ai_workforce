import { env } from '../config/env';
import { PlatformSettingsModel } from '../database/models/platform-settings.model';
import {
  PlatformSettingsSchema,
  UpdateSettingsSchema,
  type PlatformSettings,
} from './settings.types';

export type { AccessMode, PlatformSettings } from './settings.types';

export interface SettingsStore {
  read(): Promise<Partial<PlatformSettings> | null>;
  write(patch: Partial<PlatformSettings>, defaults: PlatformSettings): Promise<PlatformSettings>;
}

const SETTINGS_ID = 'platform';

const mongoSettingsStore: SettingsStore = {
  async read() {
    return PlatformSettingsModel.findById(SETTINGS_ID)
      .select('accessMode repairAttempts publishRunBranches -_id')
      .lean<PlatformSettings>()
      .exec();
  },

  async write(patch, defaults) {
    // Never replace the whole document: separate tabs may save different fields.
    // Exclude patched keys from $setOnInsert to avoid Mongo update path conflicts.
    const onInsert = Object.fromEntries(
      Object.entries(defaults).filter(([key]) => !(key in patch)),
    );
    return PlatformSettingsModel.findOneAndUpdate(
      { _id: SETTINGS_ID },
      { $set: patch, $setOnInsert: onInsert },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: false },
    )
      .select('accessMode repairAttempts publishRunBranches -_id')
      .lean<PlatformSettings>()
      .exec();
  },
};

export class SettingsService {
  constructor(
    private readonly store: SettingsStore = mongoSettingsStore,
    private readonly defaults: PlatformSettings = {
      accessMode: 'full_access',
      repairAttempts: env.WORKFLOW_REPAIR_ATTEMPTS,
      publishRunBranches: env.PUBLISH_RUN_BRANCHES,
    },
  ) {}

  /** Read for each execution decision so policy changes apply without restarting. */
  async get(): Promise<PlatformSettings> {
    const stored = await this.store.read();
    return PlatformSettingsSchema.parse({ ...this.defaults, ...stored });
  }

  /** Saving a policy is independent from explicitly resuming existing work. */
  async update(input: unknown): Promise<PlatformSettings> {
    const patch = UpdateSettingsSchema.parse(input);
    const stored = await this.store.write(patch, this.defaults);
    return PlatformSettingsSchema.parse(stored);
  }
}

export const settingsService = new SettingsService();

