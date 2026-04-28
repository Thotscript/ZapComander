import { Router } from 'express';
import { SESSIONS } from '../state.js';

const router = Router();

router.post('/send-text', async (req, res) => {
  const { sessionName, to, text } = req.body;
  if (!sessionName || !to || !text)
    return res.status(400).json({ error: 'sessionName, to e text são obrigatórios' });
  const session = SESSIONS.get(sessionName);
  if (!session)
    return res.status(404).json({ error: `Sessão '${sessionName}' não encontrada` });
  try {
    const result = await session.client.sendText(to, text);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
