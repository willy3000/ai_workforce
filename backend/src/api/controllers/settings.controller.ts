import type { Request, Response } from 'express';
import { settingsService } from '../../services/settings.service';

export const settingsController = {
  async get(_req: Request, res: Response): Promise<void> {
    res.json({ settings: await settingsService.get() });
  },

  async update(req: Request, res: Response): Promise<void> {
    res.json({ settings: await settingsService.update(req.body) });
  },
};

