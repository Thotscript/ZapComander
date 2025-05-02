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

import {criarEvento} from './Google-Agenda/calendar.js'


// Converte a URL do módulo atual em um caminho de arquivo (necessário em ES Modules)
const __filename = fileURLToPath(import.meta.url);
// Obtém o diretório atual a partir do caminho do arquivo
const __dirname = path.dirname(__filename);
// Cria uma aplicação Express
const app = express();
// Define as opções de certificado SSL para HTTPS (usando certificados do Let's Encrypt)
const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/privkey.pem'), // Chave privada
  cert: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/fullchain.pem') // Certificado público completo
};
const prompt_transcricao = fs.readFileSync(path.join(__dirname, 'prompts', 'transcricao.txt'), 'utf8');
const prompt_qualification = fs.readFileSync(path.join(__dirname, 'prompts', 'pre-qualification.txt'), 'utf8');
// Cria um servidor HTTPS usando as opções SSL e o app Express
const server = https.createServer(options, app);
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

// ===== Funções de persistência =====

export function loadAllSessionEmails() {
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
}


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

app.post('/auth/login', async (req, res) => {
  
  const {
    sessionName = null,
    email       = null
  } = req.body;

  console.log('Body recebido no login:', req.body);


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
      statusFind: (statusSession) => {
        if (statusSession === 'autocloseCalled') {
          cleanupSession(sessionName);
        }
      },
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
        args: ['--no-sandbox', '--disable-setuid-sandbox']
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
          await processAudio(sessionName, message);
        }

        if (message.type === 'chat') {
          await processText(sessionName, message);
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

// Função para enviar evento para uma sessão específica
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

//ACESSA O QRCODE PARA ENVIAR NA SESSAO A CIMA

function broadcastQR(sessionName) {
    const qrPath = `/qrcodes/qrcode_${sessionName}.png?t=${Date.now()}`;
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'qr', sessionName, qrPath }));
        }
    });
}



//VALIDA SE O USUARIO TA LOGADO PRA CONEXAO

function broadcastSessionAuthenticated(sessionName) {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'authenticated', sessionName }));
        }
    });
}


//CAPTURAR A DURACAO DO AUDIO

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

        const filtros = await loadFiltersFromDB(email, sessionName);

        const contact = await client.getContact(message.from);
        const senderName = contact.name || contact.pushname || message.from;

        console.log(`🔊 Processando áudio de ${senderName} na sessão ${sessionName}...`);


        const inputPath = path.join(AUDIO_DIR, `${message.id}.ogg`);
        const buffer = await client.decryptFile(message);

        
        fs.writeFileSync(inputPath, buffer);

        const duration = await getAudioDuration(inputPath);
        const roundduration = parseFloat(duration.toFixed(2));
        console.log(`Audio de ${roundduration} sec`);

        const formData = new FormData();
        formData.append('file', fs.createReadStream(inputPath));
        formData.append('model', 'whisper-1');

        // Chamada para transcrição no OpenAI Whisper
        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            }
        });

        const transcricao = response.data.text;

        let prompt_base = '';
        let prompt_use = transcricao;
        let recipient = '';
        
        // 1. Define o idioma base se a tradução estiver ativada
// 1. Define o idioma base se a tradução estiver ativada
        let languagePrompt = '';
        if (filtros.translation_enabled) {
          switch (filtros.language) {
            case 'pt-br':
              languagePrompt = 'traduzir qualquer mensagem para português';
              break;
            case 'en-us':
              languagePrompt = 'traduzir qualquer mensagem para inglês';
              break;
            case 'es-es':
              languagePrompt = 'traduzir qualquer mensagem para espanhol';
              break;
            default:
              console.warn('Idioma não reconhecido para tradução:', filtros.language);
              break;
          }
        }
        
        // 2. Monta a estrutura do prompt com base nos outros filtros
        if (filtros.summarizeMessages && filtros.longmessage) {
          prompt_base = `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática de mensagens transcritas de áudio, você deve devolver o texto original corrigido e então falar os tópicos do texto. Sempre pule 2 linhas e adicione ao final do texto: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
        
        } else if (filtros.summarizeMessages) {
          // Usa prompt específico (caso tenha sido definido em outro lugar, ex: variável `prompt_transcricao`)
          prompt_base = typeof prompt_transcricao !== 'undefined' ? prompt_transcricao : `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática de mensagens transcritas de áudio e então falar os tópicos do texto. Sempre pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
        
        } else if (filtros.longmessage) {
          prompt_base = `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática de mensagens transcritas de áudio. Mantenha o texto original o máximo possível, apenas fazendo correções gramaticais e de pontuação. Sempre pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
        
        } else {
          // Fallback (sem filtros extras)
          prompt_base = `Você é um assistente de IA que deve ${languagePrompt ? languagePrompt + ' e ' : ''}corrigir a gramática de textos. Sempre pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
        }
        
        
        if (filtros.sendForward){ 
          recipient = myNumber;
        } else {
          recipient = message.from;
        }

        // Chamada para resumir a transcrição no GPT-4o-mini
        const response_gpt = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: prompt_base
                    },
                    {
                        role: "user",
                        content: prompt_use
                    }
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
        const legenda = `*Transcrição do áudio de ${senderName}:* \n\n${transcricao}\n${resumo}`;
        await new Promise(resolve => setTimeout(resolve, 10));
        await client.sendText(recipient, resumo, {
            quotedMsg:message.id
        });

        fs.unlinkSync(inputPath);

        const now = new Date();
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const seconds = now.getSeconds().toString().padStart(2, '0');

        const formattedDateTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

    
        const logData = {
          email: session.email,
          numero: sessionName,
          ultimo_acesso: formattedDateTime
        };

        try {
          await saveSessionLog(logData);
          console.log('✅ Log de sessão salvo no banco.');
        } catch (err) {
          console.error('❌ Erro ao gravar log de sessão no banco:', err);
        }
        
    
        const logFilePath = path.join(SESSION_LOGS_DIR, `${sessionName}.json`);
        try {
          fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2), 'utf8');
          console.log(`Log atualizado para a sessão ${sessionName}`);
        } catch (err) {
          console.error(`Falha ao salvar log para ${sessionName}:`, err);
        }

    } catch (error) {
        console.error('❌ Erro ao processar áudio:', error?.response?.data || error.message);
    }
}

// --------------------------------------------------------------------------------------------------------

//PROCESSAR TEXTO RECEBIDO - BOT

// Controle de sessões de criação de eventos
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

    console.log(`[processText] Mensagem recebida de ${message.from}: "${text}"`);

    const lowerText = text.toLowerCase();
    const convoKey = `${sessionName}:${message.from}`;

    // 🔥 Trigger específico para criação de evento com GPT
    if (lowerText.includes('@broker') && lowerText.includes('evento')) {
      CONVERSATIONS.set(convoKey, [
        {
          role: "system",
          content: `Você é um assistente que agenda eventos no Google Calendar.
Converse com o usuário e colete as seguintes informações:
- dia do evento (formato: YYYY-MM-DD)
- hora do evento (formato: HH:mm)
- título do evento
- duração em minutos

Quando tiver todas as informações, responda SOMENTE com um JSON assim:
{
  "dia": "2025-05-03",
  "hora": "14:00",
  "titulo": "Reunião com João",
  "duracao": 90
}

Se ainda estiver coletando dados, apenas pergunte o que falta sem responder em JSON.`
        }
      ]);

      await client.sendText(message.from, '📅 Vamos criar seu evento! Me diga: qual o dia do evento?');
      return;
    }

    // 🔁 Conversa ativa (seja evento ou outro trigger normal)
    const containsTrigger = TRIGGER_KEYWORDS.some(kw => lowerText.includes(kw));
    const hasHistory = CONVERSATIONS.has(convoKey);

    if (!containsTrigger && !hasHistory) return;

    if (!CONVERSATIONS.has(convoKey)) {
      CONVERSATIONS.set(convoKey, [
        { role: "system", content: prompt_qualification }
      ]);
    }

    const history = CONVERSATIONS.get(convoKey);
    history.push({ role: "user", content: text });

    const resp = await openai.chat.completions.create({
      model: ASSISTANT_MODEL,
      messages: history,
      temperature: 0.3
    });

    const reply = resp.choices[0].message.content.trim();
    history.push({ role: "assistant", content: reply });

    // 🎯 Verifica se o GPT respondeu com um JSON válido de evento
    try {
      const jsonMatch = reply.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const eventData = JSON.parse(jsonMatch[0]);

        await criarEvento(eventData); // ✅ NOVA forma de chamada

        await client.sendText(message.from, '✅ Evento criado com sucesso!');
        CONVERSATIONS.delete(convoKey);
        return;
      }
    } catch (err) {
      console.warn('[processText] Resposta não era um JSON válido:', err.message);
    }

    // Continua a conversa normalmente (evento ou outro tema)
    await client.sendText(message.from, reply);

  } catch (err) {
    console.error(`❌ Erro crítico em processText: ${err.message}`, err.stack);
  }
}


// --------------------------------------------------------------------------------------------------------


//RESTAURAR SESSOES EM CASO DE QUEDA DO SERVIDOR


// --------------------------------------------------------------------------------------------------------


const restoreSessions = async () => {
  console.log('🔄 Restaurando sessões de:', TOKEN_DIR);

  // Lista apenas diretórios válidos (sessões, excluindo filtros e logs)
  const entries = fs.readdirSync(TOKEN_DIR, { withFileTypes: true });
  const sessionNames = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => !['filters', 'sessions_logs'].includes(name));

  console.log('→ Pastas candidatas:', sessionNames);

  for (const sessionName of sessionNames) {
    try {
      // 💡 Remoção preventiva de arquivo de lock (evita erro do Chromium)
      const lockPath = path.join(TOKEN_DIR, sessionName, 'SingletonLock');
      if (fs.existsSync(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          console.log(`🔓 Removido arquivo SingletonLock de ${sessionName}`);
        } catch (err) {
          console.warn(`⚠️ Falha ao remover SingletonLock para ${sessionName}:`, err.message);
        }
      }

      const tokenData = await myTokenStore.getToken(sessionName);
      if (!tokenData) continue;

      console.log(`🔄 Restaurando sessão: ${sessionName}`);

      const client = await wppconnect.create({
        session: sessionName,
        tokenStore: myTokenStore,
        deviceName: 'The Broker VIP',
        statusFind: (statusSession, sessionName) => {
          if (statusSession === 'autocloseCalled') {
            cleanupSession(sessionName);
          }
        },
        debug: true,
        updatesLog: true,
        headless: true,
        puppeteerOptions: {
          userDataDir: path.join(TOKEN_DIR, sessionName),
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        },
      });

      // Insere na Map com myNumber inicialmente null
      SESSIONS.set(sessionName, { client, myNumber: null, email: null });

      // Carrega e-mail salvo
      const sessionEmails = loadAllSessionEmails();
      const email = sessionEmails[sessionName] || null;
      SESSIONS.get(sessionName).email = email;

      if (email) {
        try {
          await criarOuIgnorarUsuario(email);
          console.log(`✅ Usuário '${email}' garantido no banco (restauração).`);
        } catch (dbErr) {
          console.error(`❌ Erro ao garantir usuário (restauração):`, dbErr);
        }
      }

      // Tenta obter myNumber com retry
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
        console.error(`❌ Não foi possível restaurar myNumber para ${sessionName} após várias tentativas.`);
      };

      fetchMyNumberWithRetry();

      client.onStateChange(async (state) => {
        console.log(`Estado restaurado da sessão ${sessionName}: ${state}`);

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
            await processAudio(sessionName, message);
          }

          if (message.type === 'chat') {
            await processText(sessionName, message);
          }
        } catch (error) {
          console.error(`Erro ao processar mensagem restaurada da sessão ${sessionName}:`, error);
        }
      });

    } catch (error) {
      console.error(`⚠️ Erro ao restaurar sessão ${sessionName}:`, error);
    }
  }
};


// --------------------------------------------------------------------------------------------------------
  

//INICIA A FUNCAO DE RESTAURAR SESSOES JUNTO COM O START DO SERVIDOR
restoreSessions().then(() => {
    const port = process.env.PORT;
    server.listen(port, () => {
        console.log(`🚀 Servidor rodando na porta ${port}`);
    });
});