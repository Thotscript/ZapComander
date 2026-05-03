import { Router } from 'express';
import { SESSIONS } from '../state.js';
import { loadAgents, writeAgents, runAgent } from '../services/agentProcessor.js';

const router = Router();

const RESERVED_KEYWORDS = ['\\quit', '\\q', '\\exit', '\\stop', '\\end', '/quit', '/exit', '/stop'];

function sanitizeEndKeywords(raw) {
  return (raw || '').split(',')
    .map(k => k.trim())
    .filter(k => k && !RESERVED_KEYWORDS.includes(k.toLowerCase()))
    .join(', ');
}

/* ── seed test agent if store is empty ── */
const TEST_AGENT = {
  id:              'test_imoveis_001',
  name:            'Agente Teste — Imóveis',
  description:     'Lista casas e apartamentos disponíveis (dados mockados locais)',
  keywords:        'casa, apartamento, imóvel, disponível, comprar, alugar, ver imóveis, quero ver',
  endpoint:        'https://zapbot.botcomander.com.br/api/test/imoveis',
  method:          'GET',
  requestTemplate: '',
  responsePath:    'imoveis',
  prompt:          'Você é um assistente de uma imobiliária. Com base nos imóveis disponíveis listados abaixo, responda de forma clara, organizada e amigável para o cliente no WhatsApp. Destaque apenas os imóveis disponíveis (disponivel: true), mostre preço em R$, localização e características principais. Seja conciso, use emojis adequados e termine perguntando se deseja mais informações sobre algum imóvel específico.',
  active:          true,
  createdAt:       new Date().toISOString(),
  updatedAt:       new Date().toISOString(),
};

if (loadAgents().length === 0) writeAgents([TEST_AGENT]);

/* ──────────────────────────────────────
   Endpoint de dados de teste — imóveis
─────────────────────────────────────── */
router.get('/api/test/imoveis', (req, res) => {
  res.json({
    status: 'ok',
    total:  5,
    imoveis: [
      {
        id:         1,
        tipo:       'Casa',
        endereco:   'Rua das Flores, 123 — Jardim Europa',
        cidade:     'São Paulo / SP',
        valor:      450000,
        quartos:    3,
        banheiros:  2,
        vagas:      2,
        area_m2:    120,
        disponivel: true,
        destaque:   'Próximo a escola e mercado, rua tranquila',
      },
      {
        id:         2,
        tipo:       'Apartamento',
        endereco:   'Av. Paulista, 456 — Bela Vista',
        cidade:     'São Paulo / SP',
        valor:      680000,
        quartos:    2,
        banheiros:  2,
        vagas:      1,
        area_m2:    85,
        disponivel: true,
        destaque:   'Vista privilegiada, piscina e academia no condomínio',
      },
      {
        id:         3,
        tipo:       'Casa',
        endereco:   'Rua do Ipê, 789 — Alphaville',
        cidade:     'Barueri / SP',
        valor:      1200000,
        quartos:    4,
        banheiros:  3,
        vagas:      3,
        area_m2:    280,
        disponivel: true,
        destaque:   'Condomínio fechado com segurança 24h, área de lazer completa',
      },
      {
        id:         4,
        tipo:       'Apartamento',
        endereco:   'Rua Augusta, 1010 — Consolação',
        cidade:     'São Paulo / SP',
        valor:      390000,
        quartos:    1,
        banheiros:  1,
        vagas:      1,
        area_m2:    48,
        disponivel: true,
        destaque:   'Studio moderno no coração de SP, ideal para investidores',
      },
      {
        id:         5,
        tipo:       'Casa',
        endereco:   'Rua dos Pinheiros, 321 — Pinheiros',
        cidade:     'São Paulo / SP',
        valor:      820000,
        quartos:    3,
        banheiros:  2,
        vagas:      2,
        area_m2:    160,
        disponivel: false,
        destaque:   'Reformada, quintal amplo — indisponível no momento',
      },
    ],
  });
});

/* ──────────────────────────────────────
   CRUD — Agentes
─────────────────────────────────────── */
router.get('/api/agents', (req, res) => {
  res.json(loadAgents());
});

router.post('/api/agents', (req, res) => {
  const agents = loadAgents();
  const now    = new Date().toISOString();
  const agent  = { ...req.body, updatedAt: now };
  if (!agent.id)        agent.id        = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (!agent.createdAt) agent.createdAt = now;
  agent.endKeywords = sanitizeEndKeywords(agent.endKeywords);
  agents.push(agent);
  writeAgents(agents);
  res.status(201).json(agent);
});

router.put('/api/agents/:id', (req, res) => {
  const agents = loadAgents();
  const idx    = agents.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Agente não encontrado' });
  const updated = { ...agents[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  updated.endKeywords = sanitizeEndKeywords(updated.endKeywords);
  agents[idx] = updated;
  writeAgents(agents);
  res.json(agents[idx]);
});

router.delete('/api/agents/:id', (req, res) => {
  const agents   = loadAgents();
  const filtered = agents.filter(a => a.id !== req.params.id);
  if (filtered.length === agents.length) return res.status(404).json({ error: 'Agente não encontrado' });
  writeAgents(filtered);
  res.json({ success: true });
});

/* ──────────────────────────────────────
   Disparo manual de teste
   Usa a primeira sessão ativa e envia a
   resposta para o próprio número (myNumber)
─────────────────────────────────────── */
router.post('/api/agents/test-run', async (req, res) => {
  const { message = 'quero ver imóveis disponíveis' } = req.body;

  const sessionName = [...SESSIONS.keys()][0];
  if (!sessionName) return res.status(404).json({ error: 'Nenhuma sessão ativa encontrada' });

  const session = SESSIONS.get(sessionName);
  const to      = session?.myNumber;
  if (!to) return res.status(404).json({ error: 'myNumber não disponível na sessão ativa' });

  try {
    const ok = await runAgent(sessionName, to, message);
    if (ok) return res.json({ success: true, session: sessionName, to, message });
    res.json({ success: false, reason: 'Nenhum agente ativo corresponde às palavras-chave da mensagem' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Retorna sessões ativas (para o painel de teste) */
router.get('/api/sessions/active', (req, res) => {
  const list = [...SESSIONS.entries()].map(([name, s]) => ({
    name,
    myNumber: s.myNumber,
    email:    s.email,
  }));
  res.json(list);
});

export default router;
