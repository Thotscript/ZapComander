import { Router } from 'express';
import { SESSIONS } from '../state.js';
import { loadAgents, writeAgents, runAgent } from '../services/agentProcessor.js';
import { refreshScheduler } from '../services/botScheduler.js';

const router = Router();

const RESERVED_KEYWORDS = ['\\quit', '\\q', '\\exit', '\\stop', '\\end', '/quit', '/exit', '/stop'];

function sanitizeEndKeywords(raw) {
  return (raw || '').split(',')
    .map(k => k.trim())
    .filter(k => k && !RESERVED_KEYWORDS.includes(k.toLowerCase()))
    .join(', ');
}

/* ── Endpoint de dados de teste — imóveis ── */
router.get('/api/test/imoveis', (req, res) => {
  res.json({
    status: 'ok',
    total:  5,
    imoveis: [
      { id: 1, tipo: 'Casa',        endereco: 'Rua das Flores, 123 — Jardim Europa', cidade: 'São Paulo / SP', valor: 450000,  quartos: 3, banheiros: 2, vagas: 2, area_m2: 120, disponivel: true,  destaque: 'Próximo a escola e mercado, rua tranquila' },
      { id: 2, tipo: 'Apartamento', endereco: 'Av. Paulista, 456 — Bela Vista',      cidade: 'São Paulo / SP', valor: 680000,  quartos: 2, banheiros: 2, vagas: 1, area_m2:  85, disponivel: true,  destaque: 'Vista privilegiada, piscina e academia no condomínio' },
      { id: 3, tipo: 'Casa',        endereco: 'Rua do Ipê, 789 — Alphaville',        cidade: 'Barueri / SP',   valor: 1200000, quartos: 4, banheiros: 3, vagas: 3, area_m2: 280, disponivel: true,  destaque: 'Condomínio fechado com segurança 24h, área de lazer completa' },
      { id: 4, tipo: 'Apartamento', endereco: 'Rua Augusta, 1010 — Consolação',      cidade: 'São Paulo / SP', valor: 390000,  quartos: 1, banheiros: 1, vagas: 1, area_m2:  48, disponivel: true,  destaque: 'Studio moderno no coração de SP, ideal para investidores' },
      { id: 5, tipo: 'Casa',        endereco: 'Rua dos Pinheiros, 321 — Pinheiros',  cidade: 'São Paulo / SP', valor: 820000,  quartos: 3, banheiros: 2, vagas: 2, area_m2: 160, disponivel: false, destaque: 'Reformada, quintal amplo — indisponível no momento' },
    ],
  });
});

/* ── CRUD — Agentes (isolados por email) ── */

router.get('/api/agents', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email é obrigatório' });
  res.json(loadAgents(email));
});

router.post('/api/agents', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email é obrigatório' });
  const agents = loadAgents(email);
  const now    = new Date().toISOString();
  const agent  = { ...req.body, updatedAt: now };
  if (!agent.id)        agent.id        = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (!agent.createdAt) agent.createdAt = now;
  agent.endKeywords = sanitizeEndKeywords(agent.endKeywords);
  agents.push(agent);
  writeAgents(email, agents);
  refreshScheduler();
  res.status(201).json(agent);
});

router.put('/api/agents/:id', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email é obrigatório' });
  const agents = loadAgents(email);
  const idx    = agents.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Agente não encontrado' });
  const updated = { ...agents[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  updated.endKeywords = sanitizeEndKeywords(updated.endKeywords);
  agents[idx] = updated;
  writeAgents(email, agents);
  refreshScheduler();
  res.json(agents[idx]);
});

router.delete('/api/agents/:id', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email é obrigatório' });
  const agents   = loadAgents(email);
  const filtered = agents.filter(a => a.id !== req.params.id);
  if (filtered.length === agents.length) return res.status(404).json({ error: 'Agente não encontrado' });
  writeAgents(email, filtered);
  refreshScheduler();
  res.json({ success: true });
});

/* ── Disparo de teste (somente sessões do usuário) ── */
router.post('/api/agents/test-run', async (req, res) => {
  const { message = 'quero ver imóveis disponíveis', email } = req.body;
  if (!email) return res.status(400).json({ error: 'email é obrigatório' });

  const sessionEntry = [...SESSIONS.entries()].find(([, s]) => s.email === email);
  if (!sessionEntry) return res.status(404).json({ success: false, reason: 'Nenhuma sessão ativa para este usuário' });

  const [sessionName, session] = sessionEntry;
  const to = session?.myNumber;
  if (!to) return res.status(404).json({ success: false, reason: 'myNumber não disponível na sessão ativa' });

  try {
    const ok = await runAgent(sessionName, to, message);
    if (ok) return res.json({ success: true, session: sessionName, to, message });
    res.json({ success: false, reason: 'Nenhum agente ativo corresponde às palavras-chave da mensagem' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Sessões ativas (filtradas por email) ── */
router.get('/api/sessions/active', (req, res) => {
  const { email } = req.query;
  const list = [...SESSIONS.entries()]
    .filter(([, s]) => !email || s.email === email)
    .map(([name, s]) => ({ name, myNumber: s.myNumber, email: s.email }));
  res.json(list);
});

export default router;
