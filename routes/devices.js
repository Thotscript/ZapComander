import { Router } from 'express';
import pool from '../db/index.js';

const router = Router();

router.get('/statusdevices', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email é obrigatório.' });
  try {
    const [rows] = await pool.query(`
      SELECT s.numero,
             COALESCE(MAX(l.ultimo_acesso), 'no activity') AS ultimo_acesso
        FROM sessoes s
        LEFT JOIN logs_sessao l ON l.sessao_numero = s.numero
       WHERE s.usuario_email = ?
       GROUP BY s.numero
       ORDER BY MAX(l.ultimo_acesso) DESC
    `, [email]);
    if (!rows.length) return res.status(404).json({ error: 'Nenhum número encontrado.' });
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao acessar o banco.' });
  }
});

export default router;
