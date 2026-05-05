import { Router } from 'express';
import pool from '../db/index.js';
import { SESSIONS } from '../state.js';
import { loadAgents } from '../services/agentProcessor.js';

const router = Router();

function checkAdminKey(req, res) {
  const key = req.headers['x-admin-key'] || req.query.key;
  const expected = process.env.ADMIN_KEY;
  if (!expected) { res.status(503).json({ error: 'ADMIN_KEY não configurada no servidor' }); return false; }
  if (key !== expected) { res.status(401).json({ error: 'Chave de administrador inválida' }); return false; }
  return true;
}

router.get('/api/admin/stats', async (req, res) => {
  if (!checkAdminKey(req, res)) return;

  try {
    // Usuários com totais agregados
    const [users] = await pool.query(`
      SELECT
        u.email,
        u.plano,
        DATE_FORMAT(u.criado_em, '%d/%m/%Y') AS criado_em,
        COUNT(DISTINCT s.numero)               AS total_sessoes,
        COALESCE(SUM(l.duracao_segundos), 0)   AS total_segundos,
        COALESCE(SUM(l.total_transcricoes), 0) AS total_transcricoes
      FROM usuarios u
      LEFT JOIN sessoes s ON s.usuario_email = u.email
      LEFT JOIN logs_sessao l ON l.email = u.email
      GROUP BY u.email, u.plano, u.criado_em
      ORDER BY total_segundos DESC
    `);

    // Detalhamento por número/sessão
    const [bySession] = await pool.query(`
      SELECT
        l.email,
        l.sessao_numero,
        l.duracao_segundos,
        l.total_transcricoes,
        DATE_FORMAT(l.ultimo_acesso, '%d/%m/%Y %H:%i') AS ultimo_acesso,
        s.status
      FROM logs_sessao l
      LEFT JOIN sessoes s ON s.numero = l.sessao_numero
      ORDER BY l.duracao_segundos DESC
    `);

    // Sessões atualmente online (em memória)
    const onlineEmails = new Set([...SESSIONS.values()].map(s => s.email).filter(Boolean));

    // Injeta contagem de agentes e flag online em cada usuário
    const usersEnriched = users.map(u => ({
      ...u,
      total_minutos:  parseFloat((u.total_segundos / 60).toFixed(1)),
      total_agentes:  loadAgents(u.email).length,
      online:         onlineEmails.has(u.email),
    }));

    const summary = {
      total_usuarios:     users.length,
      usuarios_online:    onlineEmails.size,
      total_sessoes:      users.reduce((a, u) => a + Number(u.total_sessoes), 0),
      total_minutos:      parseFloat((users.reduce((a, u) => a + Number(u.total_segundos), 0) / 60).toFixed(1)),
      total_transcricoes: users.reduce((a, u) => a + Number(u.total_transcricoes), 0),
    };

    res.json({ summary, users: usersEnriched, bySession });
  } catch (err) {
    console.error('Erro no admin/stats:', err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

export default router;
