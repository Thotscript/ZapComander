// Carrega variáveis de ambiente do arquivo .env para process.env
import dotenv from 'dotenv';
dotenv.config();

// Habilita o CORS (Cross-Origin Resource Sharing) para permitir requisições de diferentes origens
import cors from 'cors';
// Biblioteca para integração com o WhatsApp Web via puppeteer
import wppconnect from '@wppconnect-team/wppconnect';
// Framework para criação de servidores HTTP com rotas e middlewares
import express from 'express';
// Módulo nativo do Node.js para criar servidores HTTPS (com certificado SSL)
import https from 'https';
// Módulo nativo do Node.js para manipular o sistema de arquivos
import fs from 'fs';
// Biblioteca para criar e gerenciar conexões WebSocket (comunicação em tempo real)
import WebSocket from 'ws';
// Módulo nativo do Node.js para manipulação de caminhos de arquivos de forma cross-platform
import path from 'path';
// Cliente HTTP para fazer requisições a APIs externas
import axios from 'axios';
// Utilitário para construir requisições HTTP com arquivos/form-data
import FormData from 'form-data';
// SDK oficial da OpenAI para integração com APIs como GPT, Whisper, DALL·E etc.
import OpenAI from 'openai';
// Utilitários para converter a URL do módulo em caminhos de arquivos reais (necessário em ES Modules)
import { fileURLToPath } from 'url';
// Biblioteca para processamento de áudio e vídeo com suporte ao FFmpeg
import ffmpeg from 'fluent-ffmpeg';
// Middleware de segurança para proteger seu app Express com headers HTTP apropriados
import helmet from 'helmet';
// Conexão com o banco de dados (possivelmente um pool de conexões do PostgreSQL, MySQL, etc.)
import pool from './db/index.js';
// Função que insere um usuário no banco, se ainda não existir
import { criarOuIgnorarUsuario } from './db/usuarios.js';
// Função que insere uma sessão no banco, se ainda não existir
import { criarOuIgnorarSessao } from './db/sessions.js';
// Função para salvar logs de sessões no banco de dados
import { saveSessionLog } from './db/logs.js';

// Converte a URL do módulo atual em um caminho de arquivo (necessário em ES Modules)
const __filename = fileURLToPath(import.meta.url);
// Obtém o diretório atual a partir do caminho do arquivo
const __dirname = path.dirname(__filename);
// Cria uma aplicação Express
const app = express();
// Define as opções de certificado SSL para HTTPS (usando certificados do Let's Encrypt)
const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/fullchain.pem')
};
// Lê o conteúdo de um prompt para transcrição, armazenado em um arquivo local
const prompt_transcricao = fs.readFileSync('./prompts/transcricao.txt', 'utf8');
// Lê o conteúdo de um prompt para pré-qualificação, armazenado em um arquivo local
const prompt_qualification = fs.readFileSync('./prompts/pre-qualification.txt', 'utf8');
// Cria um servidor HTTPS usando as opções SSL e o app Express
const server = https.createServer(options, app);
// Cria um servidor WebSocket associado ao servidor HTTPS (para comunicação em tempo real)
const wss = new WebSocket.Server({ server });
// Carrega a chave da API da OpenAI a partir das variáveis de ambiente
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Cria uma instância do cliente OpenAI usando a chave da API
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
// Lê a porta do servidor a partir das variáveis de ambiente
const PORT = process.env.PORT;
// Mapa para armazenar sessões ativas em memória (pode ser vinculado a conexões de usuários ou sessões WhatsApp)
const SESSIONS = new Map();

// caminhos absolutos centralizados
const TOKEN_DIR   = '/root/wpptalk_server/tokens';
const QR_CODES_DIR = path.join(__dirname, 'public', 'qrcodes');
const AUDIO_DIR   = path.join(__dirname, 'audios');

const myTokenStore = new wppconnect.tokenStore.FileTokenStore({
  path: TOKEN_DIR
});

// para disparar o bot e guardar o histórico por conversa
const TRIGGER_KEYWORDS = ['@broker'];
const CONVERSATIONS    = new Map();
const ASSISTANT_MODEL  = 'gpt-4o-mini';

// Objeto para armazenar filtros em memória
const SESSION_FILTERS = new Map();

// garante que os folders existam
[ TOKEN_DIR, QR_CODES_DIR, AUDIO_DIR ].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

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
    for (const row of rows) {
      let value = row.valor;
      if (value === '1' || value === '0') {
        value = value === '1';
      } else {
        try { value = JSON.parse(value); } catch {}
      }
      filters[row.filtro_nome] = value;
    }
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

// ===== Rotas e lógica de sessão =====

app.get('/auth/preference-numbers', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ message: 'O envio do email é obrigatório' });
  try {
    const [rows] = await pool.query(
      'SELECT numero FROM sessoes WHERE usuario_email = ?',
      [email]
    );
    const numeros = rows.map(r => r.numero);
    return res.json({ [email]: numeros });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Erro interno do servidor' });
  }
});

app.get('/auth/blocked-numbers', async (req, res) => {
  const email = req.query.email;
  const sessionName = req.query.sessionName;
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
    if (rows.length > 0) {
      try { blocked = JSON.parse(rows[0].valor); } catch {}
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
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Nenhum filtro blockedNumbers encontrado' });
    }
    let list;
    try {
      list = JSON.parse(rows[0].valor);
      if (!Array.isArray(list)) throw new Error();
    } catch {
      return res.status(500).json({ message: 'Formato inválido no banco' });
    }
    const filtered = list.filter(num => num !== remove);
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

app.get('/auth/statusfinder', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Email é obrigatório.' });
  try {
    const [sess] = await pool.query(
      'SELECT numero FROM sessoes WHERE usuario_email = ? ORDER BY id DESC LIMIT 1',
      [email]
    );
    if (sess.length === 0) {
      return res.status(404).json({ error: 'Sessão não encontrada.' });
    }
    const sessionName = sess[0].numero;
    const [logs] = await pool.query(
      'SELECT email, numero, ultimo_acesso FROM session_logs WHERE numero = ? ORDER BY ultimo_acesso DESC LIMIT 1',
      [sessionName]
    );
    if (logs.length === 0) {
      return res.status(404).json({ error: 'Nenhum log encontrado.' });
    }
    return res.json({ sessionName, log: logs[0] });
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
        const matches = base64Qr.match(/^data:image\/png;base64,(.+)$/);
        if (!matches) return console.error('QR inválido');
        const buffer = Buffer.from(matches[1], 'base64');
        const qrFile = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
        fs.writeFileSync(qrFile, buffer);
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
        const myNumber = await client.getWid();
        const sess = SESSIONS.get(sessionName);
        sess.myNumber = myNumber;
      }
    });

    client.onAnyMessage(async message => {
      try {
        const filters = await loadFiltersFromDB(email, sessionName);
        SESSION_FILTERS.set(sessionName, filters);
        if (filters.ignoreGroups && message.isGroupMsg) return;
        if (filters.blockedNumbers && filters.blockedNumbers.includes(message.from)) return;
        if (['ptt','audio'].includes(message.type)) {
          await processAudio(sessionName, message);
        } else if (message.type === 'chat') {
          await processText(sessionName, message);
        }
      } catch (e) {
        console.error(e);
      }
    });

  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao iniciar sessão.' });
  }
});

async function processAudio(sessionName, message) {
  if (!SESSIONS.has(sessionName)) return;
  const { client, myNumber, email } = SESSIONS.get(sessionName);
  if (!myNumber) return;

  const filtros = await loadFiltersFromDB(email, sessionName);
  const contact = await client.getContact(message.from);
  const senderName = contact.name || contact.pushname || message.from;
  const inputPath = path.join(AUDIO_DIR, `${message.id}.ogg`);
  const buffer = await client.decryptFile(message);
  fs.writeFileSync(inputPath, buffer);

  const duration = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, meta) => err ? reject(err) : resolve(meta.format.duration));
  });

  const formData = new FormData();
  formData.append('file', fs.createReadStream(inputPath));
  formData.append('model', 'whisper-1');
  const respWhisper = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    { headers: { ...formData.getHeaders(), Authorization: `Bearer ${OPENAI_API_KEY}` }}
  );

  const transcricao = respWhisper.data.text;
  let prompt_base = prompt_transcricao;
  let prompt_use  = transcricao;
  if (filtros.summarizeMessages && filtros.longmessage) {
    prompt_base = 'Você é um assistente de IA que deve corrigir...';
  } else if (filtros.summarizeMessages) {
    prompt_base = prompt_transcricao;
  } else if (filtros.longmessage) {
    prompt_base = 'Você é um assistente de IA que deve corrigir...';
  }

  const respGPT = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: 'gpt-4o-mini', messages: [
      { role: 'system', content: prompt_base },
      { role: 'user', content: prompt_use }
    ]},
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }}
  );

  const resumo = respGPT.data.choices[0].message.content;
  await client.sendText(myNumber, resumo, { quotedMsg: message.id });
  fs.unlinkSync(inputPath);

  const agora = new Date();
  const formatted = agora.toISOString().replace('T', ' ').split('.')[0];
  await saveSessionLog({ email, numero: sessionName, ultimo_acesso: formatted });
}

async function processText(sessionName, message) {
  const session = SESSIONS.get(sessionName);
  if (!session || !session.myNumber) return;
  if (message.from === session.myNumber) return;
  const text = message.body?.trim();
  if (!text) return;
  const lower = text.toLowerCase();
  const key = `${sessionName}:${message.from}`;
  const triggered = TRIGGER_KEYWORDS.some(kw => lower.includes(kw));
  if (!triggered && !CONVERSATIONS.has(key)) return;

  if (!CONVERSATIONS.has(key)) {
    CONVERSATIONS.set(key, [{ role: 'system', content: prompt_qualification }]);
  }
  const history = CONVERSATIONS.get(key);
  history.push({ role: 'user', content: text });

  const resp = await openai.chat.completions.create({
    model: ASSISTANT_MODEL,
    messages: history,
    temperature: 0.7
  });

  const reply = resp.choices[0].message.content.trim();
  history.push({ role: 'assistant', content: reply });
  await session.client.sendText(message.from, reply);
}

async function cleanupSession(sessionName) {
  if (SESSIONS.has(sessionName)) {
    const { client } = SESSIONS.get(sessionName);
    await client.logout();
    await client.close();
    SESSIONS.delete(sessionName);
  }
  const qrFile = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
  if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
  const sessionPath = path.join(TOKEN_DIR, sessionName);
  setTimeout(() => {
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
  }, 3000);
}

function broadcastQR(sessionName) {
  const qrPath = `/qrcodes/qrcode_${sessionName}.png?t=${Date.now()}`;
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'qr', sessionName, qrPath }));
    }
  });
}

function broadcastSessionAuthenticated(sessionName) {
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'authenticated', sessionName }));
    }
  });
}

const restoreSessions = async () => {
  const entries = fs.readdirSync(TOKEN_DIR, { withFileTypes: true });
  const sessionNames = entries
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const sessionName of sessionNames) {
    try {
      const tokenData = await myTokenStore.getToken(sessionName);
      if (!tokenData) continue;

      const client = await wppconnect.create({
        session: sessionName,
        tokenStore: myTokenStore,
        deviceName: 'The Broker VIP',
        debug: true,
        updatesLog: true,
        headless: true,
        puppeteerOptions: {
          userDataDir: path.join(TOKEN_DIR, sessionName),
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
      });

      SESSIONS.set(sessionName, { client, myNumber: null, email: null });

      // busca email da sessão no banco
      const [[sessRow]] = await pool.query(
        'SELECT usuario_email FROM sessoes WHERE numero = ?',
        [sessionName]
      );
      const email = sessRow?.usuario_email || null;
      SESSIONS.get(sessionName).email = email;

      if (email) await criarOuIgnorarUsuario(email);

      const retryMyNumber = async (retries = 10, delay = 2000) => {
        for (let i = 0; i < retries; i++) {
          try {
            const wid = await client.getWid();
            if (wid) {
              SESSIONS.get(sessionName).myNumber = wid;
              return;
            }
          } catch {}
          await new Promise(r => setTimeout(r, delay));
        }
      };
      retryMyNumber();

      client.onStateChange(async state => {
        if (state === 'CONNECTED') {
          const wid = await client.getWid();
          SESSIONS.get(sessionName).myNumber = wid;
          await criarOuIgnorarSessao(sessionName, email);
        }
      });

      client.onAnyMessage(async message => {
        try {
          const filters = await loadFiltersFromDB(email, sessionName);
          SESSION_FILTERS.set(sessionName, filters);
          if (filters.ignoreGroups && message.isGroupMsg) return;
          if (filters.blockedNumbers && filters.blockedNumbers.includes(message.from)) return;
          if (['ptt','audio'].includes(message.type)) {
            await processAudio(sessionName, message);
          } else if (message.type === 'chat') {
            await processText(sessionName, message);
          }
        } catch (e) { console.error(e); }
      });

    } catch (e) {
      console.error('Erro ao restaurar sessão', sessionName, e);
    }
  }
};

// inicia restauração e servidor
restoreSessions().then(() => {
  server.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
});
