import { Router } from 'express';
import { config } from '../config.js';
import { isModelOnline } from '../llm/client.js';
import { slotQueue } from '../llm/queue.js';
import { requireAuth } from '../middleware.js';
import { webSearchConfigured } from '../web/search.js';

export const statusRouter = Router();
statusRouter.use(requireAuth);

statusRouter.get('/', async (_req, res) => {
  res.json({
    model: config.LLM_MODEL,
    models: config.MODELS,
    online: await isModelOnline(),
    active: slotQueue.activeCount,
    waiting: slotQueue.waitingCount,
    concurrency: slotQueue.limit,
    webSearch: webSearchConfigured,
  });
});
