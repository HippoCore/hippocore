// packages/core/src/adapters/express.js
// Optional: expose memory as an HTTP API.
// Use this when your agent runs in a different process or language.
//
// Usage:
//   import { createMemoryRouter } from '@hippo-core/core/adapters/express';
//   app.use('/memory', createMemoryRouter(config));

import { Router } from 'express';
import { addMemory, queryMemories, applyFeedback, getUserProfile, deleteMemory } from '../services/memory.js';
import { buildMemoryContext } from '../services/ai.js';

export function createMemoryRouter(config = {}) {
  const router = Router();

  // POST /add
  router.post('/add', async (req, res) => {
    const { user_id, type, content, metadata } = req.body;
    if (!user_id || !content || !type) {
      return res.status(400).json({ error: 'user_id, type, and content are required' });
    }
    try {
      const memory = await addMemory({ user_id, type, content, metadata }, config);
      return res.status(201).json({ success: true, memory });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /query
  router.post('/query', async (req, res) => {
    const { user_id, query, limit = 5, type_filter, inject = false } = req.body;
    if (!user_id || !query) {
      return res.status(400).json({ error: 'user_id and query are required' });
    }
    try {
      const memories = await queryMemories({ user_id, query, limit, type_filter }, config);
      const response = { memories };
      if (inject) response.prompt_injection = buildMemoryContext(memories);
      return res.json(response);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /feedback
  router.post('/feedback', async (req, res) => {
    const { memory_id, outcome } = req.body;
    if (!memory_id || !outcome) return res.status(400).json({ error: 'memory_id and outcome required' });
    try {
      const updated = applyFeedback({ memory_id, outcome }, config);
      if (!updated) return res.status(404).json({ error: 'Memory not found' });
      return res.json({ success: true, memory: updated });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  // GET /profile/:user_id
  router.get('/profile/:user_id', (req, res) => {
    try {
      const profile = getUserProfile(req.params.user_id, config);
      return res.json({ user_id: req.params.user_id, memories: profile });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE /:memory_id
  router.delete('/:memory_id', (req, res) => {
    try {
      const deleted = deleteMemory(req.params.memory_id, config);
      if (!deleted) return res.status(404).json({ error: 'Memory not found' });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Standalone server — use this if you want memory as a sidecar service.
 *
 * @example
 * import { startMemoryServer } from '@hippo-core/core/adapters/express';
 * startMemoryServer({ port: 3456, dbPath: './.memory/memory.db' });
 */
export async function startMemoryServer(config = {}) {
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json());
  app.use('/memory', createMemoryRouter(config));
  app.get('/health', (_, res) => res.json({ status: 'ok' }));

  const port = config.port || process.env.HIPPO_CORE_PORT || 3456;
  app.listen(port, () => console.log(`[hippo-core] Server running on :${port}`));
  return app;
}
