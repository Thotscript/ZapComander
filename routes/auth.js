import path from 'path';
import fs from 'fs';
import { Router } from 'express';
import wppconnect from '@wppconnect-team/wppconnect';
import WebSocket from 'ws';
import pool from '../db/index.js';
import { SESSIONS, sessionClients } from '../state.js';
import { criarOuIgnorarUsuario } from '../db/usuarios.js';
import { criarOuIgnorarSessao, atualizarStatusSessao, excluirSessaoPorEmail } from '../db/sessions.js';
import { cleanupSession, attachStateListener, attachMessageListener, startStatusPolling } from '../services/session.js';
import { saveQRCode } from '../utils/helpers.js';
import { broadcastQR } from '../ws/websocket.js';
import { myTokenStore, TOKEN_DIR, PUPPETEER_ARGS } from '../config/constants.js';

const router = Router();

router.post('/auth/login', async (req, res) => {
  const { sessionName, email } = req.body;
  if (!sessionName || !email)
    return res.status(400).json({ message: 'sessionName e email são obrigatórios' });
  if (SESSIONS.has(sessionName))
    return res.json({ message: `Sessão ${sessionName} já autenticada.` });

  try {
    const sessionPath = path.join(TOKEN_DIR, sessionName);

    // Apaga perfil do Chromium e token para forçar QR limpo
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    fs.mkdirSync(sessionPath, { recursive: true });
    await myTokenStore.removeToken(sessionName).catch(() => {});

    let responseSent = false;

    const client = await wppconnect.create({
      session: sessionName,
      tokenStore: myTokenStore,
      deviceName: 'The Broker VIP',
      catchQR: async base64Qr => {
        const qrFilePath = await saveQRCode(base64Qr, sessionName);
        const base       = process.env.BASE_URL || 'https://verbai.com.br:8443';
        const qrCodeURL  = `${base}/qrcodes/${path.basename(qrFilePath)}`;
        if (!responseSent) { responseSent = true; res.json({ qrCodeFile: qrCodeURL }); }
        broadcastQR(sessionName);
      },
      statusFind: status => {
        console.log(`[statusFind:${sessionName}]`, status);
        if (status === 'autocloseCalled') cleanupSession(sessionName);
        if (status === 'qrReadSuccess') {
          const ws = sessionClients.get(sessionName);
          if (ws?.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'qrReadSuccess', session: sessionName, success: true }));
        }
      },
      debug: false,
      logQR: true,
      updatesLog: false,
      headless: true,
      autoClose: 60000,
      puppeteerOptions: { userDataDir: sessionPath, args: PUPPETEER_ARGS }
    });

    await criarOuIgnorarUsuario(email).catch(err => console.error('Erro ao criar usuário:', err));

    let myNumber = null;
    try {
      await client.isConnected();
      myNumber = await client.getWid();
      await criarOuIgnorarSessao(sessionName, email);
    } catch (err) {
      console.warn(`myNumber não obtido imediatamente para ${sessionName}:`, err.message);
    }

    SESSIONS.set(sessionName, { client, myNumber, email });
    attachStateListener(client, sessionName, email);
    attachMessageListener(client, sessionName);
    startStatusPolling(sessionName);

  } catch (err) {
    console.error(`Erro ao criar sessão ${sessionName}:`, err);
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao iniciar sessão.' });
  }
});

router.get('/auth/logout', async (req, res) => {
  const { sessionName, email } = req.query;
  if (!sessionName || !email)
    return res.status(400).json({ error: 'sessionName e email são obrigatórios.' });
  try {
    await cleanupSession(sessionName);
    await excluirSessaoPorEmail(email, sessionName);
    res.json({ message: 'Sessão finalizada com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao finalizar sessão.' });
  }
});

router.get('/auth/preference-numbers', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ message: 'email é obrigatório' });
  try {
    const [rows] = await pool.query('SELECT numero FROM sessoes WHERE usuario_email = ?', [email]);
    res.json({ [email]: rows.map(r => r.numero) });
  } catch (err) {
    res.status(500).json({ message: 'Erro interno' });
  }
});

router.get('/auth/statusfinder', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email é obrigatório.' });
  try {
    const [rows] = await pool.query(`
      SELECT sessao_numero AS numero,
             DATE_FORMAT(ultimo_acesso, '%Y-%m-%d %H:%i:%s') AS ultimo_acesso
        FROM logs_sessao
       WHERE email = ?
       ORDER BY ultimo_acesso DESC
       LIMIT 1
    `, [email]);
    if (!rows.length) return res.status(404).json({ error: 'Nenhum registro encontrado.' });
    res.json({ log: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao acessar o banco.' });
  }
});

export default router;
