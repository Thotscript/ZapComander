// Carrega variáveis de ambiente do arquivo .env para process.env
import dotenv from 'dotenv';
dotenv.config();

// Dependências
import cors from 'cors';
import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import axios from 'axios';
import FormData from 'form-data';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import helmet from 'helmet';
import wppconnect from '@wppconnect-team/wppconnect';

// Banco de dados e helpers
import pool from './db/index.js';
import { criarOuIgnorarUsuario } from './db/usuarios.js';
import { criarOuIgnorarSessao } from './db/sessions.js';
import { saveSessionLog } from './db/logs.js';

// Configurações básicas
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/fullchain.pem')
};

const prompt_transcricao    = fs.readFileSync('./prompts/transcricao.txt', 'utf8');
const prompt_qualification  = fs.readFileSync('./prompts/pre-qualification.txt', 'utf8');
const server                = https.createServer(options, app);
const wss                   = new WebSocket.Server({ server });
const OPENAI_API_KEY        = process.env.OPENAI_API_KEY;
const openai                = new OpenAI({ apiKey: OPENAI_API_KEY });
const PORT                  = process.env.PORT;
const SESSIONS              = new Map();

// Diretórios
const TOKEN_DIR    = '/root/wpptalk_server/tokens';
const QR_CODES_DIR = path.join(__dirname, 'public', 'qrcodes');
const AUDIO_DIR    = path.join(__dirname, 'audios');

// Token store do wppconnect
const myTokenStore = new wppconnect.tokenStore.FileTokenStore({ path: TOKEN_DIR });

// Bot settings
const TRIGGER_KEYWORDS = ['@broker'];
const CONVERSATIONS    = new Map();
const ASSISTANT_MODEL  = 'gpt-4o-mini';
const SESSION_FILTERS  = new Map();

// Garante existência de diretórios
[ TOKEN_DIR, QR_CODES_DIR, AUDIO_DIR ].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "https://verbai.com.br:8443"],
      imgSrc:     ["'self'", "data:", "https://verbai.com.br:8443"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://verbai.com.br:8443"]
    }
  }
}));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://thebroker.vip');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use('/qrcodes', express.static(QR_CODES_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ===== Funções de persistência =====

async function loadFiltersFromDB(email, sessionName) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(
      'SELECT filtro_nome, valor FROM filtros WHERE email = ? AND sessao_numero = ?',
      [email, sessionName]
    );
    const filters = {};
    rows.forEach(row => {
      let value = row.valor;
      if (value === '1' || value === '0') {
        value = value === '1';
      } else {
        try { value = JSON.parse(value); } catch {};
      }
      filters[row.filtro_nome] = value;
    });
    return filters;
  } finally {
    conn.release();
  }
}

async function saveFiltersToDB(email, sessaoNumero, filters) {
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      'DELETE FROM filtros WHERE email = ? AND sessao_numero = ?',
      [email, sessaoNumero]
    );
    const rows = Object.entries(filters).map(([nome, valor]) => {
      let v;
      if (typeof valor === 'string')       v = valor;
      else if (typeof valor === 'boolean') v = valor ? '1' : '0';
      else                                 v = JSON.stringify(valor);
      return [ email, sessaoNumero, nome, v ];
    });
    if (rows.length > 0) {
      await conn.query(
        'INSERT INTO filtros (email, sessao_numero, filtro_nome, valor) VALUES ?',
        [rows]
      );
    }
  } finally {
    conn.release();
  }
}

// ===== Rotas =====

app.get('/auth/preference-numbers', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ message: 'O envio do email é obrigatório' });
  try {
    const [rows] = await pool.query(
      'SELECT numero FROM sessoes WHERE usuario_email = ?',
      [email]
    );
    return res.json({ [email]: rows.map(r => r.numero) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

app.get('/auth/blocked-numbers', async (req, res) => {
  const { email, sessionName } = req.query;
  if (!email || !sessionName) {
    return res.status(400).json({ message: 'Parâmetros email e sessionName são obrigatórios' });
  }
  try {
    const [rows] = await pool.query(
      `SELECT valor FROM filtros
       WHERE email = ? AND sessao_numero = ? AND filtro_nome = 'blockedNumbers'`,
      [email, sessionName]
    );
    let blocked = [];
    if (rows.length) {
      try { blocked = JSON.parse(rows[0].valor) || []; } catch {};
    }
    return res.json({ [sessionName]: blocked });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

app.delete('/auth/blocked-numbers', express.json(), async (req, res) => {
  const { email, sessionName, remove } = req.body;
  if (!email || !sessionName || !remove) {
    return res.status(400).json({ message: 'Parâmetros email, sessionName e remove são obrigatórios' });
  }
  try {
    const [rows] = await pool.query(
      `SELECT valor FROM filtros
       WHERE email = ? AND sessao_numero = ? AND filtro_nome = 'blockedNumbers'`,
      [email, sessionName]
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'Nenhum filtro blockedNumbers encontrado' });
    }
    let list;
    try {
      list = JSON.parse(rows[0].valor);
      if (!Array.isArray(list)) throw new Error();
    } catch {
      return res.status(500).json({ message: 'Formato inválido no banco' });
    }
    const filtered = list.filter(n => n !== remove);
    if (filtered.length === list.length) {
      return res.status(404).json({ message: 'Número não encontrado na lista' });
    }
    await pool.query(
      `UPDATE filtros SET valor = ?
       WHERE email = ? AND sessao_numero = ? AND filtro_nome = 'blockedNumbers'`,
      [JSON.stringify(filtered), email, sessionName]
    );
    return res.json({ success: true, removed: remove, current: filtered });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

// Ajuste: retorna sessao_numero no log para compatibilidade com plugin
app.get('/auth/statusfinder', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Email é obrigatório.' });

  try {
    const [rows] = await pool.query(
      'SELECT numero FROM sessoes WHERE usuario_email = ? LIMIT 1',
      [email]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Sessão não encontrada.' });
    }
    const sessionName = rows[0].numero;

    const [logs] = await pool.query(
      'SELECT email, sessao_numero, ultimo_acesso FROM logs_sessao WHERE sessao_numero = ? ORDER BY ultimo_acesso DESC LIMIT 1',
      [sessionName]
    );
    if (!logs.length) {
      return res.status(404).json({ error: 'Nenhum log encontrado.' });
    }
    const log = logs[0];
    return res.json({ sessionName, log });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { sessionName = null, email = null } = req.body;
  if (!sessionName || !email) {
    return res.status(400).json({ message: 'sessionName e email são obrigatórios' });
  }
  if (SESSIONS.has(sessionName)) {
    return res.json({ message: `Sessão ${sessionName} já autenticada.` });
  }

  try {
    const sessionPath = path.join(TOKEN_DIR, sessionName);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    let responseSent = false;
    const client = await wppconnect.create({
      session: sessionName,
      tokenStore: myTokenStore,
      statusFind: status => status === 'autocloseCalled' && cleanupSession(sessionName),
      deviceName: 'The Broker VIP',
      catchQR: async base64Qr => {
        const m = base64Qr.match(/^data:image\/png;base64,(.+)$/);
        if (!m) return console.error('Formato QR inválido');
        const buf = Buffer.from(m[1], 'base64');
        const qrFile = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
        fs.writeFileSync(qrFile, buf);
        if (!responseSent) {
          responseSent = true;
          res.json({ qrCodeFile: `https://verbai.com.br:8443/qrcodes/${path.basename(qrFile)}` });
        }
        broadcastQR(sessionName);
      },
      debug: true,
      updatesLog: true,
      headless: true,
      autoClose: 45000,
      puppeteerOptions: {
        userDataDir: sessionPath,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    await criarOuIgnorarUsuario(email);
    SESSIONS.set(sessionName, { client, myNumber: null, email });

    client.onStateChange(async state => {
      if (state === 'CONNECTED') {
        await criarOuIgnorarSessao(sessionName, email);
        broadcastSessionAuthenticated(sessionName);
        const wid = await client.getWid();
        SESSIONS.get(sessionName).myNumber = wid;
      }
    });

   	client.onAnyMessage(async message => {
      const sess = SESSIONS.get(sessionName);
      const filters = await loadFiltersFromDB(sess.email, sessionName);
      SESSION_FILTERS.set(sessionName, filters);
      if (filters.ignoreGroups && message.isGroupMsg) return;
      if (filters.blockedNumbers && filters.blockedNumbers.includes(message.from)) return;
      if (['ptt','audio'].includes(message.type)) await processAudio(sessionName, message);
      else if (message.type === 'chat')	await processText(sessionName, message);
    });

  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao iniciar sessão.' });
  }
});

async function processAudio(sessionName, message) {
  const sess = SESSIONS.get(sessionName);
  if (!sess || !sess.myNumber) return;

  const buffer = await sess.client.decryptFile(message);
  const inputPath = path.join(AUDIO_DIR, `${message.id}.ogg`);
  fs.writeFileSync(inputPath, buffer);

  const duration = await new Promise((r, rej) => ffmpeg.ffprobe(inputPath, (e, m) => e ? rej(e) : r(m.format.duration)));

  const formData = new FormData();
  formData.append('file', fs.createReadStream(inputPath));
  formData.append('model', 'whisper-1');
  const whisper = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, { headers: { ...formData.getHeaders(), Authorization: `Bearer ${OPENAI_API_KEY}` }});
  const transcricao = whisper.data.text;

  const filters = await loadFiltersFromDB(sess.email, sessionName);
  let prompt_base = prompt_transcricao;
  if (filters.summarizeMessages && filters.longmessage) prompt_base = 'Você é um assistente de IA que deve corrigir a gramática...';
  else if (filters.longmessage) prompt_base = 'Você é um assistente de IA que deve corrigir...';

  const gpt = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', messages: [
      { role: 'system', content: prompt_base },
      { role: 'user', content: transcricao }
    ]
  }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' }});

  const resumo = gpt.data.choices[0].message.content;
  await sess.client.sendText(sess.myNumber, resumo, { quotedMsg: message.id });
  fs.unlinkSync(inputPath);

  const now = new Date().toISOString().replace('T',' ').split('.')[0];
  await saveSessionLog({ email: sess.email, numero: sessionName, ultimo_acesso: now });
}

async function processText(sessionName, message) {
  const sess = SESSIONS.get(sessionName);
  if (!sess || !sess.myNumber) return;
  if (message.from === sess.myNumber) return;
  const text = message.body?.trim(); if (!text) return;

  const key = `${sessionName}:${message.from}`;
  if (!CONVERSATIONS.has(key)) CONVERSATIONS.set(key, [{ role:'system', content: prompt_qualification }]);
  const history = CONVERSATIONS.get(key);
  history.push({ role:'user', content: text });

  const resp = await openai.chat.completions.create({
    model: ASSISTANT_MODEL,
    messages: history,
    temperature: 0.7
  });

  const reply = resp.choices[0].message.content.trim();
  history.push({ role:'assistant', content: reply });
  await sess.client.sendText(message.from, reply);
}

async function cleanupSession(sessionName) {
  const sess = SESSIONS.get(sessionName);
  if (sess) {
    await sess.client.logout();
    await sess.client.close();
    SESSIONS.delete(sessionName);
  }
  const qrFile = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
  if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
  const sessionPath = path.join(TOKEN_DIR, sessionName);
  setTimeout(() => fs.rmSync(sessionPath, { recursive:true, force:true }), 3000);
}

function broadcastQR(sessionName) {
  const qrPath = `/qrcodes/qrcode_${sessionName}.png?t=${Date.now()}`;
  wss.clients.forEach(ws => ws.readyState===WebSocket.OPEN && ws.send(JSON.stringify({ type:'qr', sessionName, qrPath })));
}

function broadcastSessionAuthenticated(sessionName) {
  wss.clients.forEach(ws => ws.readyState===WebSocket.OPEN && ws.send(JSON.stringify({ type:'authenticated', sessionName })));
}

async function restoreSessions() {
  const dirs = fs.readdirSync(TOKEN_DIR, { withFileTypes:true });
  const sessionNames = dirs.filter(d => d.isDirectory()).map(d => d.name);
  for (const sessionName of sessionNames) {
    try {
      if (!await myTokenStore.getToken(sessionName)) continue;
      const client = await wppconnect.create({ session: sessionName, tokenStore: myTokenStore, deviceName:'The Broker VIP', debug:true, updatesLog:true, headless:true, puppeteerOptions:{ userDataDir:path.join(TOKEN_DIR, sessionName), args:['--no-sandbox','--disable-setuid-sandbox'] }});
      SESSIONS.set(sessionName, { client, myNumber:null, email:null });

      const [[sessRow]] = await pool.query('SELECT usuario_email FROM sessoes WHERE numero=?', [sessionName]);
      const email = sessRow?.usuario_email || null;
      SESSIONS.get(sessionName).email = email;
      if (email) await criarOuIgnorarUsuario(email);

      const retryMyNumber = async (retries=10, delay=2000) => {
        for (let i=0; i<retries; i++) {
          try {
            const wid = await client.getWid(); if (wid) { SESSIONS.get(sessionName).myNumber = wid; return; }
          } catch {}
          await new Promise(r=>setTimeout(r,delay));
        }
      };
      retryMyNumber();

      client.onStateChange(async state => {
        if (state==='CONNECTED') {
          const wid = await client.getWid();
          SESSIONS.get(sessionName).myNumber = wid;
          await criarOuIgnorarSessao(sessionName, email);
        }
      });

      client.onAnyMessage(async message => {
        const sess = SESSIONS.get(sessionName);
        const filters = await loadFiltersFromDB(sess.email, sessionName);
        SESSION_FILTERS.set(sessionName, filters);
        if (filters.ignoreGroups && message.isGroupMsg) return;
        if (filters.blockedNumbers && filters.blockedNumbers.includes(message.from)) return;
        if (['ptt','audio'].includes(message.type)) await processAudio(sessionName, message);
        else if (message.type==='chat') await processText(sessionName, message);
      });
    } catch (e) {
      console.error('Erro ao restaurar sessão', sessionName, e);
    }
  }
}

// Inicia restauração e servidor
restoreSessions().then(() => {
  server.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
});
