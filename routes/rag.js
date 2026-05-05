import { Router } from 'express';
import {
  processDocument,
  retrieveContext,
  listDocuments,
  deleteDocument,
  ragStats,
} from '../services/ragProcessor.js';

const router = Router();

function getParams(req, res) {
  const email   = (req.query.email   || '').trim();
  const session = (req.query.session || '').trim();
  const agentId = (req.params.agentId || '').trim();
  if (!email || !session || !agentId) {
    res.status(400).json({ error: 'email, session e agentId são obrigatórios.' });
    return null;
  }
  return { email, session, agentId };
}

router.get('/api/rag/:agentId/stats', (req, res) => {
  const p = getParams(req, res);
  if (!p) return;
  try { res.json(ragStats(p.email, p.session, p.agentId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/api/rag/:agentId/docs', (req, res) => {
  const p = getParams(req, res);
  if (!p) return;
  try { res.json(listDocuments(p.email, p.session, p.agentId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/rag/:agentId/upload', async (req, res) => {
  const p = getParams(req, res);
  if (!p) return;
  const { filename, text } = req.body || {};
  if (!filename || typeof text !== 'string')
    return res.status(400).json({ error: 'filename e text são obrigatórios.' });
  if (text.trim().length < 10)
    return res.status(400).json({ error: 'Conteúdo do arquivo muito curto.' });
  try {
    const chunks = await processDocument(p.email, p.session, p.agentId, filename, text);
    res.json({ ok: true, chunks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* filename via query param to avoid URL-encoding issues */
router.delete('/api/rag/:agentId/docs', (req, res) => {
  const p = getParams(req, res);
  if (!p) return;
  const filename = (req.query.filename || '').trim();
  if (!filename) return res.status(400).json({ error: 'filename é obrigatório.' });
  try {
    deleteDocument(p.email, p.session, p.agentId, filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/rag/:agentId/query', async (req, res) => {
  const p = getParams(req, res);
  if (!p) return;
  const { query, topK } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query é obrigatório.' });
  try {
    const results = await retrieveContext(p.email, p.session, p.agentId, query, Number(topK) || 5);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
