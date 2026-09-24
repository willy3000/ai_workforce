import { Schema, model } from 'mongoose';
import type { PlatformSettings } from '../../services/settings.types';

export interface IPlatformSettings extends PlatformSettings {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
}

const PlatformSettingsSchema = new Schema<IPlatformSettings>(
  {
    // One installation currently serves one operator. A fixed primary key keeps
    // concurrent first saves from creating competing policy documents.
    _id: { type: String, required: true },
    accessMode: { type: String, enum: ['full_access', 'requires_approval'], required: true },
    repairAttempts: { type: Number, min: 0, max: 10, required: true },
    publishRunBranches: { type: Boolean, required: true },
  },
  { timestamps: true, collection: 'platform_settings' },
);

export const PlatformSettingsModel = model<IPlatformSettings>('PlatformSettings', PlatformSettingsSchema);

