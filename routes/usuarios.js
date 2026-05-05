import { Router } from 'express';
import { registrarUsuario, autenticarUsuario } from '../db/usuarios.js';

const router = Router();

router.post('/api/user/register', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha)
    return res.status(400).json({ error: 'email e senha são obrigatórios' });
  if (senha.length < 6)
    return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres' });
  try {
    await registrarUsuario(email, senha);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao registrar usuário:', err);
    res.status(500).json({ error: 'Erro ao registrar usuário' });
  }
});

router.post('/api/user/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha)
    return res.status(400).json({ error: 'email e senha são obrigatórios' });
  try {
    const user = await autenticarUsuario(email, senha);
    if (!user) return res.status(401).json({ error: 'E-mail ou senha inválidos' });
    res.json({ email: user.email, plano: user.plano });
  } catch (err) {
    console.error('Erro ao autenticar usuário:', err);
    res.status(500).json({ error: 'Erro interno ao autenticar' });
  }
});

export default router;
