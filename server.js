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
import { excluirSessaoPorEmail } from './db/sessions.js';
import { insertDefaultFilters } from './db/default-filter.js';
// Função que insere uma sessão no banco, se ainda não existir
import { criarOuIgnorarSessao } from './db/sessions.js';
// Função para salvar logs de sessões no banco de dados
import { saveSessionLog } from './db/logs.js';
import { constants } from 'crypto';
const { scheduleReminder } = require('./modulos/reminderManager.js');
import { spawn } from 'child_process';


const processingQueues = new Map();

// Converte a URL do módulo atual em um caminho de arquivo (necessário em ES Modules)
const __filename = fileURLToPath(import.meta.url);
// Obtém o diretório atual a partir do caminho do arquivo
const __dirname = path.dirname(__filename);
// Cria uma aplicação Express
const app = express();
// Define as opções de certificado SSL para HTTPS (usando certificados do Let's Encrypt)
const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/fullchain.pem'),
  secureOptions:
    constants.SSL_OP_NO_SSLv2 |
    constants.SSL_OP_NO_SSLv3 |
    constants.SSL_OP_NO_TLSv1 |
    constants.SSL_OP_NO_TLSv1_1,
  ciphers: [
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384'
  ].join(':'),
  honorCipherOrder: true
};
const prompt_transcricao = fs.readFileSync(path.join(__dirname, 'prompts', 'transcricao.txt'), 'utf8');
const prompt_qualification = fs.readFileSync(path.join(__dirname, 'prompts', 'pre-qualification.txt'), 'utf8');
// Cria um servidor HTTPS usando as opções SSL e o app Express
const server = https.createServer(options, app);

const logStream = fs.createWriteStream('/var/log/wpptalk-errors.log', { flags: 'a' });

server.on('clientError', (err, socket) => {
  const ip = socket.remoteAddress || 'IP desconhecido';
  const linha = `${new Date().toISOString()} | IP: ${ip} | clientError: ${err.message}\n`;
  logStream.write(linha);
  socket.destroy();
});

// Cria um servidor WebSocket associado ao servidor HTTPS (para comunicação em tempo real)
const wss = new WebSocket.Server({ server });
// Carrega a chave da API da OpenAI a partir das variáveis de ambiente
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Carrega (se necessário) um prompt de pré-qualificação a partir do .env
const PROMPT_PRE_QUALIFICACAO = process.env.PROMPT_PRE_QUALIFICACAO;
// Cria uma instância do cliente OpenAI usando a chave da API
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
// Lê a porta do servidor a partir das variáveis de ambiente
const PORT = process.env.PORT;
// Mapa para armazenar sessões ativas em memória (pode ser vinculado a conexões de usuários ou sessões WhatsApp)
const SESSIONS = new Map();


// caminhos absolutos centralizados
const TOKEN_DIR        = '/root/wpptalk_server/tokens';
const FILTERS_FILE     = path.join(TOKEN_DIR, 'filters', 'filters.json');
const SESSIONS_FILE    = path.join(TOKEN_DIR, 'sessions.json');
const SESSION_LOGS_DIR = path.join(TOKEN_DIR, 'sessions_logs');
const QR_CODES_DIR = path.join(__dirname, 'public', 'qrcodes');
const AUDIO_DIR    = path.join(__dirname, 'audios');

const myTokenStore = new wppconnect.tokenStore.FileTokenStore({
  path: TOKEN_DIR
});

// para disparar o bot e guardar o histórico por conversa
const TRIGGER_KEYWORDS = ["@broker"];
const CONVERSATIONS    = new Map();
const ASSISTANT_MODEL  = "gpt-4o-mini";

// Objeto para armazenar filtros em memória
const SESSION_FILTERS = new Map();


// garante que os folders existam
[ 
  path.dirname(FILTERS_FILE),
  path.dirname(SESSIONS_FILE),
  SESSION_LOGS_DIR,
  QR_CODES_DIR,
  AUDIO_DIR,
  TOKEN_DIR
].forEach(dir => {
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

// ===== Rotas e lógica de sessão =====

app.get('/auth/preference-numbers', async (req, res) => {
  
  const email = req.query.email;

  if (!email) {
    return res
      .status(400)
      .json({ message: 'O envio do email é obrigatório' });
  }

  try {
    // busca todos os registros na tabela `sessoes` cujo usuario_email = email
    const [rows] = await pool.query(
      'SELECT numero FROM sessoes WHERE usuario_email = ?',
      [email]
    );

    const numeros = rows.map(row => row.numero);

    // monta o JSON com chave dinâmica
    return res.json({ [email]: numeros });
  } catch (err) {
    console.error('Erro ao buscar preference-numbers:', err);
    return res
      .status(500)
      .json({ message: 'Erro interno do servidor' });
  }
});

// ------------------------------------------------------------------------------

app.get('/auth/blocked-numbers', async (req, res) => {
  const email       = req.query.email;
  const sessionName = req.query.sessionName;

  if (!email || !sessionName) {
    return res
      .status(400)
      .json({ message: 'Os parâmetros email e sessionName são obrigatórios' });
  }

  try {
    // 1) Busque todas as linhas blockedNumbers
    const [rows] = await pool.query(
      `SELECT valor 
         FROM filtros 
        WHERE email = ? 
          AND sessao_numero = ? 
          AND filtro_nome = 'blockedNumbers'`,
      [email, sessionName]
    );

    // 2) Extraia o campo `valor` de cada linha em um array
    const blocked = rows.map(r => r.valor);

    // 3) Retorne usando a chave dinâmica (ou fixe uma)
    return res.json({ [sessionName]: blocked });
  } catch (err) {
    console.error('Erro ao buscar blockedNumbers:', err);
    return res
      .status(500)
      .json({ message: 'Erro interno do servidor' });
  }
});




// -----------------------------------------------------------------------------


app.delete('/auth/blocked-numbers', express.json(), async (req, res) => {
  const { email, sessionName, remove } = req.body;

  if (!email || !sessionName || !remove) {
    return res
      .status(400)
      .json({ message: 'Parâmetros email, sessionName e remove são obrigatórios' });
  }

  try {
    // Apaga diretamente a linha cujo valor casa com o número a remover
    const [result] = await pool.execute(
      `DELETE FROM filtros
         WHERE email = ?
           AND sessao_numero = ?
           AND filtro_nome = 'blockedNumbers'
           AND valor = ?`,
      [email, sessionName, String(remove)]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ message: 'Número não encontrado na lista de blockedNumbers' });
    }

    return res.json({
      success: true,
      message: `Número ${remove} removido com sucesso.`,
    });
  } catch (err) {
    console.error('Erro ao remover blockedNumber:', err);
    return res
      .status(500)
      .json({ message: 'Erro interno ao remover número bloqueado' });
  }
});



// -----------------------------------------------------------------------------

app.get('/statusdevices', async (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: 'Email é obrigatório.' });
  }

  try {
    // Busca os números vinculados ao email e os últimos acessos, se existirem
    const [rows] = await pool.query(
      `
      SELECT s.numero, 
             COALESCE(MAX(l.ultimo_acesso), 'no activity') AS ultimo_acesso
      FROM sessoes s
      LEFT JOIN logs_sessao l ON l.sessao_numero = s.numero
      WHERE s.usuario_email = ?
      GROUP BY s.numero
      ORDER BY MAX(l.ultimo_acesso) DESC
      `,
      [email]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Nenhum número encontrado para este email.' });
    }

    return res.json({
      logs: rows.map(row => ({
        numero: row.numero,
        ultimo_acesso: row.ultimo_acesso
      }))
    });
  } catch (err) {
    console.error(`❌ Erro ao buscar sessões para o email ${email}:`, err);
    return res.status(500).json({ error: 'Erro ao acessar o banco de dados.' });
  }
});




app.get('/auth/statusfinder', async (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: 'Email é obrigatório.' });
  }

  try {
    // Busca a sessão mais recente
    const [rows] = await pool.query(
      `SELECT sessao_numero AS numero, ultimo_acesso
       FROM logs_sessao
       WHERE email = ?
       ORDER BY ultimo_acesso DESC
       LIMIT 1`,
      [email]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Nenhum registro encontrado para este email.' });
    }

    return res.json({
      log: {
        numero: rows[0].numero,
        ultimo_acesso: rows[0].ultimo_acesso
      }
    });
  } catch (err) {
    console.error(`❌ Erro ao buscar status para o email ${email}:`, err);
    return res.status(500).json({ error: 'Erro ao acessar o banco de dados.' });
  }
});


// ----------------------------------------------------------------------------------
app.get('/auth/logout', async (req, res) => {
  const sessionName = req.query.sessionName;
  const email = req.query.email;

  if (!sessionName || !email) {
    return res.status(400).json({ error: 'Parâmetros obrigatórios: sessionName e email.' });
  }

  try {
    // Encerra a sessão do WhatsApp ou outro serviço
    await cleanupSession(sessionName);

    // Exclui dados relacionados ao email no banco de dados
    await excluirSessaoPorEmail(email, sessionName);

    res.status(200).json({ message: 'Sessão finalizada e dados excluídos com sucesso.' });
  } catch (err) {
    console.error('Erro ao excluir sessão:', err);
    res.status(500).json({ error: 'Erro ao finalizar sessão ou excluir dados.' });
  }
});


// ------------------------------------------------------------------------------------


function enqueueProcessing(sessionName, fn) {
  const queue = processingQueues.get(sessionName) || Promise.resolve();

  const newQueue = queue
    .then(() => fn())
    .catch((err) => {
      console.error(`Erro ao processar fila da sessão ${sessionName}:`, err);
    })
    .finally(() => {
      console.log(`✅ Fila de processamento concluída para a sessão: ${sessionName}`);
    });

  processingQueues.set(sessionName, newQueue);
}


app.post('/auth/login', async (req, res) => {
  
  const {
    sessionName = null,
    email       = null
  } = req.body;

  console.log('Body recebido no login:', req.body);
  console.log('📥 Requisição recebida do IP:', req.ip);


  if (!sessionName || !email) {
    return res
      .status(400)
      .json({ message: 'sessionName e email são obrigatórios' });
  }

  if (SESSIONS.has(sessionName)) {
    return res.json({ message: `Sessão ${sessionName} já autenticada.` });
  }

  try {
    console.log(`Criando sessão: ${sessionName}`);
    const sessionPath = path.join(TOKEN_DIR, sessionName);
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    let responseSent = false;
    const client = await wppconnect.create({
      session: sessionName,
      tokenStore: myTokenStore,
      deviceName: 'The Broker VIP',
      catchQR: async (base64Qr) => {
        const qrFilePath = await saveQRCode(base64Qr, sessionName);
        const qrCodeURL = `https://verbai.com.br:8443/qrcodes/${path.basename(qrFilePath)}`;
        if (!responseSent) {
          responseSent = true;
          res.json({ qrCodeFile: qrCodeURL });
        }
        broadcastQR(sessionName);
      },
      statusFind: (statusSession) => {
        if (statusSession === 'autocloseCalled') {
          cleanupSession(sessionName);
        }
        if (statusSession === 'qrReadSuccess') {
          sendToSession(sessionName, {
            type: 'qrReadSuccess',
            session: sessionName,
            success: true
          });
        }
      },
      debug: true,
      updatesLog: true,
      headless: true,
      autoClose: 45000,
      puppeteerOptions: {
        userDataDir: sessionPath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-client-side-phishing-detection',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-hang-monitor',
          '--disable-popup-blocking',
          '--disable-sync',
          '--disable-translate',
          '--metrics-recording-only',
          '--no-first-run',
          '--safebrowsing-disable-auto-update',
          '--mute-audio'
        ]
      }
    });

    if (email) {
      try {
        await criarOuIgnorarUsuario(email);
        console.log(`✅ Usuário '${email}' garantido no banco.`);
      } catch (dbErr) {
        console.error(`❌ Erro ao garantir usuário:`, dbErr);
      }
    }

    SESSIONS.set(sessionName, {
      client,
      myNumber: null,
      email
    });

    client.onStateChange(async (state) => {
      try {
        console.log(`Estado da sessão ${sessionName}: ${state}`);
    
        if (state === 'CONNECTED') {
          try {
            await criarOuIgnorarSessao(sessionName, email);
            await insertDefaultFilters(email, sessionName);
            console.log(`✅ Sessão '${sessionName}' registrada no banco.`);
          } catch (dbErr) {
            console.error(`❌ Erro ao registrar sessão:`, dbErr);
          }
    
          broadcastSessionAuthenticated(sessionName);
    
          const myNumber = await client.getWid();
          const session = SESSIONS.get(sessionName);
          session.myNumber = myNumber;
    
          const sessionToken = await client.getSessionTokenBrowser();
          await myTokenStore.setToken(sessionName, sessionToken); 
          console.log('Token salvo com sucesso!');
    
          const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
          if (fs.existsSync(qrFilePath)) {
            setTimeout(() => {
              fs.unlink(qrFilePath, () => {
                console.log(`Sessão ${sessionName} autenticada, QR Code removido!`);
              });
            }, 10000);
          }
    
        } else if (['DISCONNECTED', 'CLOSE', 'UNPAIRED', 'CONFLICT'].includes(state)) {
          console.warn(`⚠️ Sessão ${sessionName} entrou em estado: ${state}. Iniciando limpeza...`);
          await cleanupSession(sessionName);
        } else if (state === 'OFFLINE') {
          console.warn(`⚠️ Sessão ${sessionName} entrou em estado OFFLINE. Reiniciando...`);
          restartSessionIfOffline(sessionName, email);
        }

    
      } catch (error) {
        console.error(`⚠️ Erro no onStateChange da sessão ${sessionName}:`, error);
      }
    });
    

    client.onAnyMessage(async (message) => {

      try {

        const filters = await loadFiltersFromDB(email, sessionName);
        SESSION_FILTERS.set(sessionName, filters);

        if (filters.ignoreGroups && message.isGroupMsg) return;
        if (filters.blockedNumbers && filters.blockedNumbers.includes(message.from)) return;

        if (message.type === 'ptt' || message.type === 'audio') {
          enqueueProcessing(sessionName, () => processAudio(sessionName, message));
        }

        if (message.type === 'chat') {
          await processText(sessionName, message, email);
        }
        
      } catch (error) {
        console.error(`Erro ao processar mensagem na sessão ${sessionName}:`, error);
      }
    });

  } catch (err) {
    console.error(`❌ Erro ao criar sessão ${sessionName}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro ao iniciar sessão.' });
    }
  }
});



// -------------------------------------------------------------------------------------

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

      if (row.filtro_nome === 'blockedNumbers') {
        // Caso especial: mantém array de strings
        // Se quiser um array, você pode agrupar múltiplas linhas:
        if (!filters.blockedNumbers) {
          filters.blockedNumbers = [];
        }
        filters.blockedNumbers.push(value);
        continue;
      }

      // Para os demais filtros:
      if (value === '1' || value === '0') {
        value = (value === '1');
      } else {
        try {
          value = JSON.parse(value);
        } catch {
          // mantém como string quando não for JSON válido
        }
      }
      filters[row.filtro_nome] = value;
    }

    return filters;
  } finally {
    conn.release();
  }
}



async function saveFiltersToDB(email, sessaoNumero, filters) {
  // Remove blockedNumbers do objeto antes de tudo
  const { blockedNumbers, ...otherFilters } = filters;

  const conn = await pool.getConnection();
  try {
    // Limpa apenas os filtros que NÃO são blockedNumbers
    await conn.execute(
      `DELETE FROM filtros
        WHERE email = ?
          AND sessao_numero = ?
          AND filtro_nome <> 'blockedNumbers'`,
      [email, sessaoNumero]
    );

    // Prepara as linhas só para otherFilters
    const rows = Object.entries(otherFilters).map(([nome, valor]) => {
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



// -----------------------------------------------------------------------------------------

//ROTA FILTROS

async function loadBlockedNumbersFromDB(email, sessionName) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT valor 
         FROM filtros 
        WHERE email = ? 
          AND sessao_numero = ? 
          AND filtro_nome = 'blockedNumbers'`,
      [email, sessionName]
    );
    // rows é um array de objetos { valor: '5511...' }
    return rows.map(r => r.valor);
  } finally {
    conn.release();
  }
}


app.post('/auth/filtro', async (req, res) => {
  const {
    sessionName,
    email,
    ignoreGroups,
    blockedNumbers,
    summarizeMessages,
    longmessage,
    sendForward,
    language,
    translation_enabled
  } = req.body;

  if (!sessionName) {
    return res.status(400).json({ message: 'sessionName é obrigatório.' });
  }

  if (!email) {
    return res.status(400).json({ message: 'Email é obrigatório para salvar no banco de dados.' });
  }

  if (req.body.hasOwnProperty('blockedNumbers')) {
    // Fluxo especial para blockedNumbers
    const novos = (Array.isArray(blockedNumbers)
      ? blockedNumbers
      : [blockedNumbers]
    ).map(String);

    try {
      const existentes = await loadBlockedNumbersFromDB(email, sessionName);
      const soNovos = novos.filter(num => !existentes.includes(num));
      if (soNovos.length === 0) {
        return res.json({
          message: 'Nenhum número novo para adicionar.',
          blockedNumbers: existentes
        });
      }

      const rows = soNovos.map(num => [ email, sessionName, 'blockedNumbers', num ]);
      await pool.query(
        'INSERT INTO filtros (email, sessao_numero, filtro_nome, valor) VALUES ?',
        [rows]
      );

      const updated = existentes.concat(soNovos);
      return res.json({
        message: 'Novos blockedNumbers adicionados.',
        blockedNumbers: updated
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Erro ao processar blockedNumbers.' });
    }
  }

  // Se chegou aqui, é porque não era blockedNumbers
  const currentFilters = SESSION_FILTERS.get(sessionName) || {};
  const updatedFilters = {
    ...currentFilters,
    ...(language !== undefined && { language }),
    ...(translation_enabled !== undefined && { translation_enabled }),
    ...(sendForward !== undefined && { sendForward: !!sendForward }),
    ...(ignoreGroups !== undefined && { ignoreGroups: !!ignoreGroups }),
    ...(summarizeMessages !== undefined && { summarizeMessages: !!summarizeMessages }),
    ...(longmessage !== undefined && { longmessage: !!longmessage }),
  };

  SESSION_FILTERS.set(sessionName, updatedFilters);

  try {
    await saveFiltersToDB(email, sessionName, updatedFilters);
    return res.json({ message: `Filtros atualizados com sucesso.` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Não foi possível salvar filtros.' });
  }
});



// -------------------------------------------------------------------------------------------------


  //CARREGA OS FILTROS

  async function loadFilters() {
    const filtersPath = '/root/wpptalk_server/tokens/filters/filters.json';
    const data = fs.readFileSync(filtersPath, 'utf-8'); // Lê o conteúdo do arquivo
    return JSON.parse(data); // Parseia o JSON para um objeto JavaScript
}

 //CARREGA A SESSAO

async function loadSessions() {
    const sessionsPath = '/root/wpptalk_server/tokens/sessions_logs/sessions.json';
    const data = fs.readFileSync(sessionsPath, 'utf-8');
    return JSON.parse(data);
}

// ----------------------------------------------------------------------------------------------------

app.post('/auth/blockednumbers', async (req, res) => {
    const { email, number } = req.body;
  
    if (!email || !number) {
      return res.status(400).json({ error: 'Email e número são obrigatórios.' });
    }
  
    try {
      // Espera carregar as sessões e filtros
      const sessions = await loadSessions();
      const sessionEmail = sessions[number];
  
      if (!sessionEmail) {
        return res.status(404).json({ error: 'Número não encontrado na sessão.' });
      }
  
      if (sessionEmail !== email) {
        return res.status(403).json({ error: 'Email não corresponde ao número informado.' });
      }
  
      const filters = await loadFilters();
      const userFilters = filters[number];
  
      if (!userFilters || !userFilters.blockedNumbers) {
        return res.status(404).json({ error: 'Nenhum número bloqueado encontrado para esta sessão.' });
      }
  
      const blockedNumbers = userFilters.blockedNumbers.map(num => num.replace('@c.us', ''));
  
      return res.json({ blockedNumbers });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao processar a requisição', details: err.message });
    }
});

// ----------------------------------------------------------------------------------------------------


//FUNCTION PARA SALVAR O QRCODE NA PASTA

function saveQRCode(base64Qr, sessionName) {
    const matches = base64Qr.match(/^data:image\/png;base64,(.+)$/);
    if (!matches) return console.error('Formato de QR Code inválido.');

    const imageBuffer = Buffer.from(matches[1], 'base64');
    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);

    return new Promise((resolve, reject) => {
        fs.writeFile(qrFilePath, imageBuffer, (err) => {
            if (err) {
                console.error('Erro ao salvar QR Code:', err);
                reject(err);
            } else {
                resolve(qrFilePath);
            }
        });
    });
}

// ----------------------------------------------------------------------------------------------------


//ROTA DE LOGOUT

app.get('/auth/logout', async (req, res) => {
  const session = req.query.sessionName;
  
  if (!session) {
      return res.status(400).json({ error: 'Session é obrigatório.' });
  }

  try {
      // Chama a função de limpeza da sessão
      await cleanupSession(session);

      // Retorna uma resposta indicando sucesso
      res.status(200).json({ message: 'Sessão finalizada com sucesso.' });
  } catch (error) {
      // Em caso de erro, retorna uma resposta com erro
      res.status(500).json({ error: 'Erro ao finalizar sessão.' });
  }
});

// ----------------------------------------------------------------------------------------------------


//LIMPAR PASTAS DE SESSAO

async function cleanupSession(sessionName) {
  const session = SESSIONS.get(sessionName);

  if (session) {
    try {
      const client = session.client;

      // ✅ Verifica se a página ainda está viva (prevenção de detached frame)
      if (client && client.page && !client.page.isClosed()) {
        try {
          await client.logout();
        } catch (err) {
          console.warn(`⚠️ Erro ao dar logout em ${sessionName}:`, err.message);
        }

        try {
          await client.close();
        } catch (err) {
          console.warn(`⚠️ Erro ao fechar cliente ${sessionName}:`, err.message);
        }
      } else {
        console.warn(`⚠️ Página já estava fechada ou inválida para sessão ${sessionName}.`);
      }

      SESSIONS.delete(sessionName);
      console.log(`🔴 Sessão ${sessionName} encerrada.`);
    } catch (err) {
      console.error(`❌ Erro ao limpar sessão ${sessionName}:`, err.message);
    }
  }

  const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
  if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath);

  const sessionPath = path.join(TOKEN_DIR, sessionName);
  setTimeout(() => {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`🧹 Sessão [${sessionName}] removida do sistema de arquivos.`);
    }
  }, 3000);
}


// --------------------------------------------------------------------------------------------------------

//WEBSOCKET PARA ENVIAR O QRCODE PARA O FRONT
const sessionClients = new Map(); // sessionName => ws

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // Cliente informa qual sessão ele quer escutar
            if (data.type === 'requestQR' && data.sessionName) {
                sessionClients.set(data.sessionName, ws);
                console.log(`🔗 Cliente associado à sessão: ${data.sessionName}`);
                broadcastQR(data.sessionName); // opcional: envie QR logo após associação
            }
        } catch (error) {
            console.error('❌ Erro ao processar mensagem WebSocket:', error);
        }
    });

    ws.on('close', () => {
        // Limpa sessões que pertenciam a este socket
        for (const [sessionName, clientWs] of sessionClients.entries()) {
            if (clientWs === ws) {
                sessionClients.delete(sessionName);
                console.log(`❌ Cliente da sessão ${sessionName} desconectado`);
            }
        }
    });
});

function sendToSession(sessionName, payload) {
    const client = sessionClients.get(sessionName);
    if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(payload));
        console.log(`📤 Mensagem enviada à sessão ${sessionName}`);
    } else {
        console.warn(`⚠️ Nenhum cliente conectado para a sessão ${sessionName}`);
    }
}

// --------------------------------------------------------------------------------------------------------

function broadcastQR(sessionName) {
    const qrPath = `/qrcodes/qrcode_${sessionName}.png?t=${Date.now()}`;
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'qr', sessionName, qrPath }));
        }
    });
}


function broadcastSessionAuthenticated(sessionName) {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'authenticated', sessionName }));
        }
    });
}


async function getAudioDuration(inputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) {
                reject('❌ Erro ao obter metadados do áudio: ' + err.message);
            } else {
                resolve(metadata.format.duration); // Retorna a duração em segundos
            }
        });
    });
}

// ===================================================================================================== GESTAO DE PROMPTS E GPTS


async function handleTriggerWithConversation(triggerName, session, message, input) {
  const client = session.client;
  const sender = message.from;
  let prompt;

  // Buscar prompt no banco ou arquivo
  try {
    const [rows] = await pool.query(
      'SELECT prompt FROM agentes WHERE `trigger` = ? AND ativo = 1 LIMIT 1',
      [triggerName]
    );

    prompt = rows.length > 0
      ? rows[0].prompt
      : loadPrompt(triggerName);

    if (rows.length === 0) {
      console.warn(`⚠️ Prompt do trigger "${triggerName}" não encontrado no banco. Usando arquivo local.`);
    }
  } catch (err) {
    console.error('❌ Erro ao consultar prompt do banco:', err.message);
    prompt = loadPrompt(triggerName); // fallback
  }

  const userText = typeof input === 'string'
    ? input
    : '[Atenção: input de áudio já deveria estar transcrito antes de ser passado aqui]';

  const gptResponse = await sendPromptToGPT(prompt, userText);

  // ✅ Se for trigger "lembrete", tenta agendar a ação
  if (triggerName === 'lembrete') {
    try {
      const json = JSON.parse(gptResponse);

      if (json.tipo === 'lembrete' && json.delayMinutos && json.conteudo) {
        const delayMs = json.delayMinutos * 60 * 1000;
        const mensagem = `🔔 Lembrete: ${json.conteudo}`;
        scheduleReminder(session.sessionName, sender, mensagem, delayMs, client.sendText.bind(client));
        await client.sendText(sender, `✅ Lembrete agendado para daqui a ${json.delayMinutos} minutos.`);
      } else {
        await client.sendText(sender, `⚠️ O formato do lembrete não foi reconhecido corretamente.`);
      }
    } catch (e) {
      console.error('❌ Erro ao interpretar JSON do GPT para lembrete:', e.message);
      await client.sendText(sender, `⚠️ Não consegui entender o lembrete. Tente reformular.`);
    }
  } else {
    await client.sendText(sender, `💬 *${capitalize(triggerName)} detectado:*\n${gptResponse}`);
  }

  const convoKey = `${session.myNumbe }:${sender}`;
  CONVERSATIONS.set(convoKey, {
    history: [
      { role: 'system', content: prompt },
      { role: 'user', content: userText },
      { role: 'assistant', content: gptResponse }
    ],
    activeTrigger: triggerName
  });
}


function loadPrompt(promptName) {
  const promptPath = path.join(__dirname, 'prompts', `${promptName}.txt`);
  return fs.readFileSync(promptPath, 'utf8');
}

async function sendPromptToGPT(promptSystemInstructions, userText) {
  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: promptSystemInstructions },
      { role: 'user', content: userText }
    ]
  }, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data.choices[0].message.content.trim();
}

// Função utilitária para capitalizar texto
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Handlers simplificados usando a função genérica
async function handleTriggerEvento(session, message, input) {
  return handleTriggerWithConversation('evento', session, message, input);
}

async function handleTriggerTarefa(session, message, input) {
  return handleTriggerWithConversation('tarefa', session, message, input);
}

async function handleTriggerLembrete(session, message, input) {
  return handleTriggerWithConversation('lembrete', session, message, input);
}

async function handleTriggerFinanciamento(session, message, input) {
  return handleTriggerWithConversation('financiamento', session, message, input);
}


// Mapeamento de triggers e suas funções
const TRIGGERS = {
  evento: handleTriggerEvento,
  tarefa: handleTriggerTarefa,
  lembrete: handleTriggerLembrete,
  financiamento: handleTriggerFinanciamento
};

// Detecta trigger com base no áudio bruto
async function checkTriggerInAudio(buffer) {
  const formData = new FormData();
  const tempFile = path.join(AUDIO_DIR, `temp_trigger.ogg`);
  fs.writeFileSync(tempFile, buffer);
  formData.append('file', fs.createReadStream(tempFile));
  formData.append('model', 'whisper-1');

  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${OPENAI_API_KEY}`
      }
  });

  const transcript = response.data.text;

  const checkPrompt = `
  Analise a transcrição de áudio abaixo e identifique se o usuário está solicitando a ativação de alguma das seguintes funções: "evento", "tarefa", "lembrete" ou "financiamento".

  Responda **apenas** com uma das palavras: "evento", "tarefa", "lembrete", "financiamento".

  Se a transcrição indicar um pedido como "me avise", "me lembra", "não esquecer", "me recordar", "me lembrar", "lembrar de", ou outras formas de lembrete com indicação de tempo (como minutos, horas, data, horário), **responda com "lembrete"**.

  Se não encontrar nenhum desses gatilhos, responda apenas com "nenhum".

  Transcrição:
  """${transcript}"""
  `;


  const result = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
          { role: 'system', content: 'Você é um classificador de intenções baseado em texto.' },
          { role: 'user', content: checkPrompt }
      ]
  }, {
      headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
      }
  });

  fs.unlinkSync(tempFile); // remove arquivo temporário

  return result.data.choices[0].message.content.trim().toLowerCase();
}

// =======================================================================================================================================================

//PROCESSAR AUDIO RECEBIDO


// --------------------------------------------------------------------------------------------------------


async function processAudio(sessionName, message) {
  try {
    if (!SESSIONS.has(sessionName)) throw new Error(`Sessão ${sessionName} não encontrada.`);

    const session = SESSIONS.get(sessionName);
    const client = session.client;
    const myNumber = session.myNumber;
    const email = session.email;

    if (!myNumber) {
      console.error(`⚠️ Número da sessão ${sessionName} ainda não definido.`);
      return;
    }

    let buffer = await client.decryptFile(message);


    const trigger = await checkTriggerInAudio(buffer);
    if (trigger !== 'nenhum' && TRIGGERS[trigger]) {
      await TRIGGERS[trigger](session, message, buffer);
      return;
    }

    const filtros = await loadFiltersFromDB(email, sessionName);

    const contact = await client.getContact(message.from);
    const senderName = contact.name || contact.pushname || message.from;

    console.log(`🔊 Processando áudio de ${senderName} na sessão ${sessionName}...`);

    const inputPath = path.join(AUDIO_DIR, `${message.id}.ogg`);
    const denoisedPath = path.join(AUDIO_DIR, `${message.id}_clean.ogg`);

    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(inputPath);
      stream.write(buffer, (err) => err ? reject(err) : resolve());
      stream.end();
    });

    buffer = null;

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ['-i', inputPath, '-af', 'afftdn', '-y', denoisedPath]);
      ffmpeg.stderr.on('data', data => console.log(`FFmpeg: ${data}`));
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`)));
    });

    const duration = await getAudioDuration(denoisedPath);
    console.log(`Audio de ${parseFloat(duration.toFixed(2))} sec`);

    const formData = new FormData();
    formData.append('file', fs.createReadStream(denoisedPath));
    formData.append('model', 'whisper-1');

    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: {
        ...formData.getHeaders(),
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      }
    });

    const transcricao = response.data.text;

    let languagePrompt = '';
    if (filtros.translation_enabled) {
      switch (filtros.language) {
        case 'pt-br': languagePrompt = 'traduzir qualquer mensagem para português'; break;
        case 'en-us': languagePrompt = 'traduzir qualquer mensagem para inglês'; break;
        case 'es-es': languagePrompt = 'traduzir qualquer mensagem para espanhol'; break;
        default: console.warn('Idioma não reconhecido para tradução:', filtros.language);
      }
    }

    let prompt_base = '';
    if (filtros.summarizeMessages && filtros.longmessage) {
      prompt_base = `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática de mensagens transcritas de áudio, devolver o texto corrigido e então listar os tópicos do texto. Pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
    } else if (filtros.summarizeMessages) {
      prompt_base = `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática de mensagens transcritas de áudio e listar os tópicos. Pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
    } else if (filtros.longmessage) {
      prompt_base = `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática mantendo o texto original o máximo possível. Pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
    } else {
      prompt_base = `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática do texto. Pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
    }

    const recipient = (filtros.sendForward === true || filtros.sendForward === '1' || filtros.sendForward === 1)
      ? myNumber
      : message.from;

    const response_gpt = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: prompt_base },
          { role: "user", content: transcricao }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const resumo = response_gpt.data.choices[0].message.content;

    await new Promise(resolve => setTimeout(resolve, 10));
    await client.sendText(recipient, resumo, { quotedMsg: message.id });

    fs.unlinkSync(inputPath);
    fs.unlinkSync(denoisedPath);

    const now = new Date();
    const logData = {
      email: session.email,
      numero: sessionName,
      ultimo_acesso: now.toISOString().replace('T', ' ').substring(0, 19)
    };

    try {
      await saveSessionLog(logData);
      console.log('✅ Log de sessão salvo no banco.');
    } catch (err) {
      console.error('❌ Erro ao gravar log de sessão no banco:', err);
    }

    try {
      const logFilePath = path.join(SESSION_LOGS_DIR, `${sessionName}.json`);
      fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2), 'utf8');
      console.log(`Log atualizado para a sessão ${sessionName}`);
    } catch (err) {
      console.error(`Falha ao salvar log para ${sessionName}:`, err);
    }

  } catch (error) {
    console.error('❌ Erro ao processar áudio:', error?.response?.data || error.message);
  }
}




app.get('/api/agentes', async (req, res) => {
  try {
    const { ativo } = req.query;

    let query = 'SELECT id, nome, trigger, modelo, ativo, criado_em, atualizado_em FROM agentes';
    const params = [];

    if (ativo !== undefined) {
      query += ' WHERE ativo = ?';
      params.push(ativo === 'true' ? 1 : 0);
    }

    const [rows] = await db.execute(query, params);

    res.json(rows);
  } catch (err) {
    console.error('[API /api/agentes] Erro:', err);
    res.status(500).json({ erro: 'Erro interno ao listar agentes' });
  }
});


app.get('/api/agentes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.execute(
      'SELECT id, nome, trigger, prompt, modelo, ativo, criado_em, atualizado_em FROM agentes WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ erro: 'Agente não encontrado' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[API /api/agentes/:id] Erro:', err);
    res.status(500).json({ erro: 'Erro interno ao buscar agente' });
  }
});



app.post('/api/agentes', async (req, res) => {
  try {
    const { id, nome, trigger, prompt, modelo = 'gpt-4o-mini', ativo = 1 } = req.body;

    if (!nome || !trigger || !prompt) {
      return res.status(400).json({ erro: 'Campos obrigatórios: nome, trigger e prompt' });
    }

    if (id) {
      // Atualiza agente existente
      const [result] = await db.execute(
        `UPDATE agentes
         SET nome = ?, trigger = ?, prompt = ?, modelo = ?, ativo = ?, atualizado_em = NOW()
         WHERE id = ?`,
        [nome, trigger, prompt, modelo, ativo, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ erro: 'Agente não encontrado para atualização' });
      }

      res.json({ mensagem: 'Agente atualizado com sucesso' });
    } else {
      // Cria novo agente
      const [result] = await db.execute(
        `INSERT INTO agentes (nome, trigger, prompt, modelo, ativo)
         VALUES (?, ?, ?, ?, ?)`,
        [nome, trigger, prompt, modelo, ativo]
      );

      res.status(201).json({ mensagem: 'Agente criado com sucesso', id: result.insertId });
    }
  } catch (err) {
    console.error('[API /api/agentes] Erro:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ erro: 'Trigger já está em uso por outro agente' });
    } else {
      res.status(500).json({ erro: 'Erro interno do servidor' });
    }
  }
});

// --------------------------------------------------------------------------------------------------------


async function checkTriggerInText(text) {
 const checkPrompt = `
Analise a transcrição de áudio abaixo e identifique se o usuário está solicitando a ativação de alguma das seguintes funções: "evento", "tarefa", "lembrete" ou "financiamento".

Responda **apenas** com uma das palavras: "evento", "tarefa", "lembrete", "financiamento".

Se a transcrição indicar um pedido como "me avise", "me lembra", "não esquecer", "me recordar", "me lembrar", "lembrar de", ou outras formas de lembrete com indicação de tempo (como minutos, horas, data, horário), **responda com "lembrete"**.

Se não encontrar nenhum desses gatilhos, responda apenas com "nenhum".

Transcrição:
"""${transcript}"""
`;


  const result = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Você é um classificador de intenções baseado em texto.' },
      { role: 'user', content: checkPrompt }
    ]
  }, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  const resposta = result.data.choices[0].message.content.trim().toLowerCase();
  console.log(`[checkTriggerInText] Resposta do GPT: ${resposta}`);
  return resposta;
}



const EVENT_CREATION_SESSIONS = new Map();

async function processText(sessionName, message, email) {
  try {
    const session = SESSIONS.get(sessionName);
    if (!session) throw new Error(`Sessão ${sessionName} não encontrada.`);

    const { client, myNumber } = session;
    if (!myNumber) {
      console.log('[processText] Número da sessão não definido. Abortando.');
      return;
    }

    if (message.from === myNumber) return;

    const text = message.body?.trim();
    if (!text) return;

    const lowerText = text.toLowerCase();
    const convoKey = `${session.myNumber}:${message.from}`;
    const stored = CONVERSATIONS.get(convoKey);

    // 🛑 Comando para encerrar o bot ativo
    if (lowerText === 'tbvoff') {
      if (stored?.activeTrigger) {
        await client.sendText(message.from, '🔕 Bot desativado. Você voltou ao fluxo normal.');

        // 🔁 Substitui o estado inteiro da conversa para evitar continuidade
        CONVERSATIONS.set(convoKey, {
          history: [],
          activeTrigger: null
        });
      } else {
        await client.sendText(message.from, 'ℹ️ Nenhum bot ativo para desativar.');
      }
      return;
    }



    // 🧠 Se já existe trigger ativo, continue com o histórico
    if (stored?.activeTrigger && TRIGGERS[stored.activeTrigger]) {
      const gptHistory = stored.history;
      gptHistory.push({ role: 'user', content: text });

      const resp = await openai.chat.completions.create({
        model: ASSISTANT_MODEL,
        messages: gptHistory,
        temperature: 0.3
      });

      const reply = resp.choices[0].message.content.trim();
      gptHistory.push({ role: 'assistant', content: reply });

      await client.sendText(message.from, reply);
      return;
    }

    const trigger = (await checkTriggerInText(text)).trim().toLowerCase();
    console.log(`[processText] Trigger identificado: '${trigger}'`);
    if (trigger && trigger !== 'nenhum' && TRIGGERS.hasOwnProperty(trigger)) {
      await TRIGGERS[trigger](session, message, text);
      return;
    }


    // 💬 Conversa padrão (fluxo com prompt_qualification)
    const containsTrigger = lowerText.includes('@broker');
    const hasHistory = stored?.history?.length > 0;

    if (!containsTrigger && !hasHistory) return;

    if (!hasHistory) {
      CONVERSATIONS.set(convoKey, {
        history: [{ role: "system", content: prompt_qualification }],
        activeTrigger: null
      });
    }

    const updated = CONVERSATIONS.get(convoKey);
    updated.history.push({ role: "user", content: text });

    const resp = await openai.chat.completions.create({
      model: ASSISTANT_MODEL,
      messages: updated.history,
      temperature: 0.3
    });

    const reply = resp.choices[0].message.content.trim();
    updated.history.push({ role: "assistant", content: reply });

    await client.sendText(message.from, reply);

  } catch (err) {
    console.error(`❌ Erro crítico em processText: ${err.message}`, err.stack);
  }
}





// --------------------------------------------------------------------------------------------------------


//RESTAURAR SESSOES EM CASO DE QUEDA DO SERVIDOR


// --------------------------------------------------------------------------------------------------------
const RESTARTING_SESSIONS = new Set();

function restartSessionIfOffline(sessionName, email) {
  if (RESTARTING_SESSIONS.has(sessionName)) return;
  RESTARTING_SESSIONS.add(sessionName);

  enqueueProcessing(sessionName, async () => {
    try {
      const current = SESSIONS.get(sessionName);
      if (!current) return;

      console.log(`🔁 Reiniciando sessão ${sessionName} após estado OFFLINE...`);
      await cleanupSession(sessionName);
      await new Promise(r => setTimeout(r, 2000));
      await restoreSession({ sessionName, email });
    } catch (err) {
      console.error(`❌ Falha ao restaurar sessão ${sessionName}:`, err);
    } finally {
      RESTARTING_SESSIONS.delete(sessionName);
    }
  });
}


const restoreSessions = async () => {
  try {
    // 1. Consulta todas as sessões salvas no banco
    const [rows] = await pool.query(`
      SELECT numero AS sessionName, usuario_email AS email
      FROM sessoes
    `);

    if (rows.length === 0) {
      console.log('Nenhuma sessão encontrada no banco para restaurar.');
      return;
    }

    console.log('→ Sessões encontradas:', rows.map(r => r.sessionName));
    
    // 2. Criar fila de sessões para restauração
    const sessionQueue = rows.filter(({ sessionName }) => !SESSIONS.has(sessionName));
    
    if (sessionQueue.length === 0) {
      console.log('⚠️ Todas as sessões já estão ativas. Nada para restaurar.');
      return;
    }
    
    console.log(`📋 Fila de restauração criada com ${sessionQueue.length} sessões`);
    
    // 3. Definir função para processar lotes da fila
    const MAX_CONCURRENT_RESTORATIONS = 3;
    let activeRestorations = 0;
    let queueIndex = 0;
    
    const processNextBatch = async () => {
      while (queueIndex < sessionQueue.length && activeRestorations < MAX_CONCURRENT_RESTORATIONS) {
        const session = sessionQueue[queueIndex++];
        activeRestorations++;
        
        // Iniciar restauração de forma assíncrona
        console.log(`🔄 Iniciando restauração de ${session.sessionName} (${activeRestorations}/${MAX_CONCURRENT_RESTORATIONS} ativos)`);
        
        restoreSession(session)
          .finally(() => {
            activeRestorations--;
            console.log(`✅ Restauração de sessão concluída. Restaurações ativas: ${activeRestorations}`);
            
            // Continuar processando a fila se ainda houver sessões
            if (queueIndex < sessionQueue.length) {
              processNextBatch();
            } else if (activeRestorations === 0) {
              console.log('🎉 Todas as sessões foram processadas com sucesso!');
            }
          });
      }
    };
    
    const restoreSession = async ({ sessionName, email }) => {
      try {
        console.log(`⏳ Restaurando sessão: ${sessionName}`);
        
        const sessionPath = path.join(TOKEN_DIR, sessionName);
        const lockPath = path.join(sessionPath, 'SingletonLock');
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
          console.log(`🔓 Removido arquivo SingletonLock de ${sessionName}`);
        }

        const tokenData = await myTokenStore.getToken(sessionName);
        if (!tokenData) {
          console.warn(`⚠️ Token não encontrado para sessão ${sessionName}, pulando.`);
          return;
        }

        const client = await wppconnect.create({
          session: sessionName,
          tokenStore: myTokenStore,
          deviceName: 'The Broker VIP',
          statusFind: (statusSession) => {
            if (statusSession === 'autocloseCalled') {
              cleanupSession(sessionName);
            }
          },
          debug: true,
          updatesLog: true,
          headless: true,
          puppeteerOptions: {
            userDataDir: sessionPath,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',          // usa disco ao invés de RAM
              '--disable-background-networking',  // evita conexões desnecessárias
              '--disable-background-timer-throttling',
              '--disable-client-side-phishing-detection',
              '--disable-default-apps',
              '--disable-extensions',
              '--disable-hang-monitor',
              '--disable-popup-blocking',
              '--disable-sync',
              '--disable-translate',
              '--metrics-recording-only',
              '--no-first-run',
              '--safebrowsing-disable-auto-update',
              '--mute-audio'
            ]
          }
        });

        SESSIONS.set(sessionName, { client, myNumber: null, email });

        if (email) {
          try {
            await criarOuIgnorarUsuario(email);
            console.log(`✅ Usuário '${email}' garantido no banco (restauração).`);
          } catch (dbErr) {
            console.error(`❌ Erro ao garantir usuário (restauração):`, dbErr);
          }
        }

        // Recuperar número
        const fetchMyNumberWithRetry = async (retries = 10, delayMs = 2000) => {
          for (let attempt = 1; attempt <= retries; attempt++) {
            try {
              const myNumber = await client.getWid();
              if (myNumber) {
                SESSIONS.get(sessionName).myNumber = myNumber;
                console.log(`Número restaurado para ${sessionName}: ${myNumber}`);
                return;
              }
            } catch (err) {
              console.warn(`Tentativa ${attempt} falhou ao obter myNumber para ${sessionName}: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, delayMs));
          }
          console.error(`❌ Não foi possível restaurar myNumber para ${sessionName}`);
        };

        fetchMyNumberWithRetry();

        client.onStateChange(async (state) => {
          console.log(`Estado restaurado da sessão ${sessionName}: ${state}`);
          
          try {
            if (state === 'CONNECTED') {
              try {
                const myNumber = await client.getWid();
                SESSIONS.get(sessionName).myNumber = myNumber;
                console.log(`Número restaurado (via onStateChange) para ${sessionName}: ${myNumber}`);
              } catch (err) {
                console.error(`Erro ao obter myNumber no onStateChange para ${sessionName}:`, err);
              }
        
              try {
                await criarOuIgnorarSessao(sessionName, email);
                console.log(`✅ Sessão '${sessionName}' registrada no banco (restauração).`);
              } catch (dbErr) {
                console.error(`❌ Erro ao registrar sessão (restauração):`, dbErr);
              }
        
            } else if (['DISCONNECTED', 'CLOSE', 'UNPAIRED', 'CONFLICT'].includes(state)) {
              console.warn(`⚠️ Sessão ${sessionName} entrou em estado crítico (${state}) durante restauração. Iniciando limpeza...`);
              await cleanupSession(sessionName);
        
            } else if (state === 'OFFLINE') {
              console.warn(`⚠️ Sessão ${sessionName} entrou em estado OFFLINE. Reiniciando...`);
              restartSessionIfOffline(sessionName, email);
            }
        
          } catch (error) {
            console.error(`⚠️ Erro no onStateChange (restauração) da sessão ${sessionName}:`, error);
          }
        });
        
        
        client.onAnyMessage(async (message) => {
          try {
            const filters = await loadFiltersFromDB(email, sessionName);
            SESSION_FILTERS.set(sessionName, filters);

            if (filters.ignoreGroups && message.isGroupMsg) return;
            if (filters.blockedNumbers && filters.blockedNumbers.includes(message.from)) return;

            if (message.type === 'ptt' || message.type === 'audio') {
              console.log(`Mensagem de áudio recebida na sessão ${sessionName}. Processando...`);
              enqueueProcessing(sessionName, () => processAudio(sessionName, message));
            }

            if (message.type === 'chat') {
              await processText(sessionName, message, email);
            }

          } catch (error) {
            console.error(`Erro ao processar mensagem restaurada da sessão ${sessionName}:`, error);
          }
        });
        
        console.log(`✅ Sessão ${sessionName} restaurada com sucesso`);
        return client;

      } catch (error) {
        console.error(`⚠️ Erro ao restaurar sessão ${sessionName}:`, error);
        throw error; // Propagando o erro para o finally do chamador
      }
    };
    
    // 5. Iniciar o processamento do primeiro lote
    await processNextBatch();
    
  } catch (err) {
    console.error('❌ Erro ao consultar sessões no banco:', err);
  }
};

//INICIA A FUNCAO DE RESTAURAR SESSOES JUNTO COM O START DO SERVIDOR
restoreSessions().then(() => {
    const port = process.env.PORT;
    server.listen(port, () => {
        console.log(`🚀 Servidor rodando na porta ${port}`);
    });
});