import path from 'path';
import fs from 'fs';
import wppconnect from '@wppconnect-team/wppconnect';
import { SESSIONS, RESTARTING_SESSIONS } from '../state.js';
import { processAudio } from './audio.js';
import { broadcastSessionAuthenticated } from '../ws/websocket.js';
import { criarOuIgnorarSessao, atualizarStatusSessao } from '../db/sessions.js';
import { criarOuIgnorarUsuario } from '../db/usuarios.js';
import { enqueueProcessing } from '../utils/helpers.js';
import { myTokenStore, TOKEN_DIR, TEMP_DIR, PUPPETEER_ARGS } from '../config/constants.js';
import pool from '../db/index.js';

export async function cleanupSession(sessionName) {
  const session = SESSIONS.get(sessionName);
  if (session) {
    try {
      if (session.client?.page && !session.client.page.isClosed()) {
        await session.client.logout().catch(() => {});
        await session.client.close().catch(() => {});
      }
    } catch (err) {
      console.warn(`Erro ao fechar sessão ${sessionName}:`, err.message);
    }
    SESSIONS.delete(sessionName);
    console.log(`🔴 Sessão ${sessionName} encerrada.`);
  }
  try {
    const prefix = `qrcode_${sessionName}_`;
    fs.readdirSync(TEMP_DIR)
      .filter(f => f.startsWith(prefix))
      .forEach(f => { try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {} });
  } catch {}
  const sessionPath = path.join(TOKEN_DIR, sessionName);
  setTimeout(() => {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`🧹 Sessão [${sessionName}] removida do sistema de arquivos.`);
    }
  }, 3000);
  try {
    await pool.query('DELETE FROM sessoes WHERE numero = ?', [sessionName]);
  } catch (err) {
    console.error(`Erro ao remover ${sessionName} do banco:`, err.message);
  }
}

export function startStatusPolling(sessionName) {
  setInterval(async () => {
    const s = SESSIONS.get(sessionName);
    if (!s) return;
    try {
      const state = await s.client.getConnectionState();
      await atualizarStatusSessao(sessionName, state);
    } catch {}
  }, 30_000);
}

export function attachMessageListener(client, sessionName) {
  client.onAnyMessage(async message => {
    try {
      const session = SESSIONS.get(sessionName);
      if (!session) return;

      if (!session.myNumber) {
        try {
          const wid = await client.getWid();
          if (wid) session.myNumber = wid;
        } catch {}
      }
      if (!session.myNumber) return;

      if (message.from === session.myNumber) return;
      if (message.isGroupMsg) return;

      if (message.type === 'ptt' || message.type === 'audio') {
        enqueueProcessing(sessionName, () => processAudio(sessionName, message));
      }
    } catch (err) {
      console.error(`Erro ao processar mensagem na sessão ${sessionName}:`, err);
    }
  });
}

export function attachStateListener(client, sessionName, email) {
  client.onStateChange(async state => {
    console.log(`[${sessionName}] Estado: ${state}`);
    try { await atualizarStatusSessao(sessionName, state); } catch {}

    if (state === 'CONNECTED' || state === 'MAIN') {
      try {
        const wid = await client.getWid();
        const session = SESSIONS.get(sessionName);
        if (session) session.myNumber = wid;
      } catch {}
      try { await criarOuIgnorarSessao(sessionName, email); } catch {}
      broadcastSessionAuthenticated(sessionName);
    } else if (['DISCONNECTED', 'CLOSE', 'UNPAIRED', 'CONFLICT'].includes(state)) {
      console.warn(`⚠️ ${sessionName} → ${state}. Limpando...`);
      await cleanupSession(sessionName);
    } else if (state === 'OFFLINE') {
      console.warn(`⚠️ ${sessionName} OFFLINE. Reiniciando...`);
      restartSessionIfOffline(sessionName, email);
    }
  });
}

export function restartSessionIfOffline(sessionName, email) {
  if (RESTARTING_SESSIONS.has(sessionName)) return;
  RESTARTING_SESSIONS.add(sessionName);
  enqueueProcessing(sessionName, async () => {
    try {
      await cleanupSession(sessionName);
      await new Promise(r => setTimeout(r, 2000));
      await restoreSession({ sessionName, email });
    } catch (err) {
      console.error(`Falha ao restaurar ${sessionName}:`, err);
    } finally {
      RESTARTING_SESSIONS.delete(sessionName);
    }
  });
}

export const restoreSession = async ({ sessionName, email }) => {
  try {
    console.log(`⏳ Restaurando sessão: ${sessionName}`);
    const sessionPath = path.join(TOKEN_DIR, sessionName);
    const lockPath    = path.join(sessionPath, 'SingletonLock');
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);

    const tokenData = await myTokenStore.getToken(sessionName);
    if (!tokenData) { console.warn(`Token não encontrado para ${sessionName}.`); return; }

    const client = await wppconnect.create({
      session: sessionName,
      tokenStore: myTokenStore,
      deviceName: 'The Broker VIP',
      statusFind: status => { if (status === 'autocloseCalled') cleanupSession(sessionName); },
      debug: false,
      updatesLog: false,
      headless: true,
      puppeteerOptions: { userDataDir: sessionPath, args: PUPPETEER_ARGS }
    });

    let myNumber = null;
    try {
      await client.isConnected();
      myNumber = await client.getWid();
      await criarOuIgnorarSessao(sessionName, email);
    } catch (err) {
      console.warn(`myNumber não obtido na restauração de ${sessionName}:`, err.message);
    }

    if (!SESSIONS.has(sessionName)) {
      SESSIONS.set(sessionName, { client, myNumber, email });
    }

    await criarOuIgnorarUsuario(email).catch(() => {});
    attachStateListener(client, sessionName, email);
    attachMessageListener(client, sessionName);
    startStatusPolling(sessionName);

    console.log(`✅ Sessão ${sessionName} restaurada.`);
  } catch (err) {
    console.error(`Erro ao restaurar ${sessionName}:`, err);
  }
};

export const restoreSessions = async () => {
  try {
    const [rows] = await pool.query('SELECT numero AS sessionName, usuario_email AS email FROM sessoes');
    if (!rows.length) { console.log('Nenhuma sessão para restaurar.'); return; }
    console.log('Sessões encontradas:', rows.map(r => r.sessionName));
    const queue = rows.filter(r => !SESSIONS.has(r.sessionName));
    const MAX_CONCURRENT = 3;
    let active = 0, idx = 0;
    const next = async () => {
      while (idx < queue.length && active < MAX_CONCURRENT) {
        const s = queue[idx++];
        active++;
        restoreSession(s).finally(() => { active--; next(); });
      }
    };
    await next();
  } catch (err) {
    console.error('Erro ao restaurar sessões:', err);
  }
};
