// Carrega variáveis de ambiente do arquivo .env para process.env
import dotenv from 'dotenv';
dotenv.config();
import cors from 'cors';
import wppconnect from '@wppconnect-team/wppconnect';
import express from 'express';
import https from 'https';
import fs from 'fs';
import WebSocket from 'ws';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import helmet from 'helmet';
import pool from './db/index.js';
import { criarOuIgnorarUsuario } from './db/usuarios.js';
import { excluirSessaoPorEmail, atualizarStatusSessao, criarOuIgnorarSessao} from './db/sessions.js';
import { insertDefaultFilters } from './db/default-filter.js';
import { saveFiltersToDB } from './db/saveFilters.js';
import { saveSessionLog } from './db/logs.js';
import { saveEventoToDB } from './db/eventos.js';
import { constants } from 'crypto';
import { spawn } from 'child_process';
import { DateTime } from 'luxon';
import { createRequire } from 'module';
import { google } from 'googleapis';
import tls from 'tls';
import puppeteer from 'puppeteer';
import crypto from 'crypto';



/**
 * Aguarda a descriptografia de uma mensagem ciphertext e retorna a versão completa.
 * @param {object} client - instância do wppconnect
 * @param {object} message - mensagem original com type='ciphertext'
 * @param {number} maxAttempts - quantas tentativas
 * @param {number} delayMs - intervalo entre tentativas
 * @returns {object} mensagem reidratada ou a original se falhar
 */
async function waitForDecryptedMessage(client, message, maxAttempts = 5, delayMs = 800) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, delayMs));
    try {
      const fullMsg = await client.getMessageById(message.id);
      if (fullMsg && fullMsg.type !== 'ciphertext') {
        console.log(`✅ [DECRYPT] Mensagem reidratada na tentativa ${attempt}: type=${fullMsg.type}`);
        return fullMsg;
      }
      console.log(`⏳ [DECRYPT] Tentativa ${attempt}/${maxAttempts} - ainda ciphertext...`);
    } catch (e) {
      console.warn(`⚠️ [DECRYPT] Tentativa ${attempt} falhou: ${e.message}`);
    }
  }
  console.warn(`❌ [DECRYPT] Não foi possível reidratar mensagem ${message.id} após ${maxAttempts} tentativas`);
  return null; // descarta
}


// ===== SISTEMA DE TIMEOUT AUTOMÁTICO PARA BOTS =====

// Mapa para armazenar os timeouts ativos
const CONVERSATION_TIMEOUTS = new Map();
const BOT_TIMEOUT_DURATION = 15 * 60 * 1000; // 15 minutos em millisegundos

/**
 * Define ou atualiza o timeout para uma conversa específica
 * @param {string} convoKey - Chave da conversa (formato: "myNumber:senderNumber")
 * @param {object} session - Objeto da sessão com client
 * @param {string} senderNumber - Número do remetente
 */
function setConversationTimeout(convoKey, session, senderNumber) {
  // Limpar timeout existente se houver
  clearConversationTimeout(convoKey);
  
  console.log(`⏰ Definindo timeout de 15min para conversa: ${convoKey}`);
  
  const timeoutId = setTimeout(async () => {
    try {
      console.log(`⏰ Timeout atingido para conversa: ${convoKey}`);
      
      const conversation = CONVERSATIONS.get(convoKey);
      if (conversation?.activeTrigger) {
        console.log(`🔕 Desativando bot automático para ${convoKey} - trigger: ${conversation.activeTrigger}`);
        
        // Remover a conversa da memória
        CONVERSATIONS.delete(convoKey);
        
        // Remover o timeout da lista
        CONVERSATION_TIMEOUTS.delete(convoKey);
        
        // Enviar mensagem de notificação ao usuário
        await session.client.sendText(
          senderNumber,
          '⏰ *Fluxo desativado por falta de interação*\n\n' +
          'Por favor, reenvie sua pergunta caso precise de mais ajuda!\n\n' +
          '_Timeout: 15 minutos de inatividade_'
        );
        
        console.log(`✅ Notificação de timeout enviada para: ${senderNumber}`);
      } else {
        console.log(`ℹ️ Conversa ${convoKey} já estava inativa quando o timeout foi executado`);
      }
    } catch (error) {
      console.error(`❌ Erro ao processar timeout para ${convoKey}:`, error);
    }
  }, BOT_TIMEOUT_DURATION);
  
  // Armazenar o timeout para possível cancelamento
  CONVERSATION_TIMEOUTS.set(convoKey, {
    timeoutId,
    startTime: Date.now(),
    senderNumber,
    session
  });
}

/**
 * Limpa o timeout de uma conversa específica
 * @param {string} convoKey - Chave da conversa
 */
function clearConversationTimeout(convoKey) {
  const timeoutInfo = CONVERSATION_TIMEOUTS.get(convoKey);
  if (timeoutInfo) {
    clearTimeout(timeoutInfo.timeoutId);
    CONVERSATION_TIMEOUTS.delete(convoKey);
    console.log(`🔄 Timeout cancelado para conversa: ${convoKey}`);
  }
}

/**
 * Atualiza o timeout de uma conversa (reseta o timer)
 * @param {string} convoKey - Chave da conversa
 * @param {object} session - Objeto da sessão
 * @param {string} senderNumber - Número do remetente
 */
function refreshConversationTimeout(convoKey, session, senderNumber) {
  const conversation = CONVERSATIONS.get(convoKey);
  
  // Só renovar timeout se a conversa tem um trigger ativo
  if (conversation?.activeTrigger) {
    console.log(`🔄 Renovando timeout para conversa ativa: ${convoKey}`);
    setConversationTimeout(convoKey, session, senderNumber);
  }
}

/**
 * Função auxiliar para obter informações de timeout (debug)
 * @param {string} convoKey - Chave da conversa
 * @returns {object|null} Informações do timeout ou null se não existir
 */
function getTimeoutInfo(convoKey) {
  const timeoutInfo = CONVERSATION_TIMEOUTS.get(convoKey);
  if (!timeoutInfo) return null;
  
  const elapsed = Date.now() - timeoutInfo.startTime;
  const remaining = BOT_TIMEOUT_DURATION - elapsed;
  
  return {
    elapsed: Math.floor(elapsed / 1000), // segundos
    remaining: Math.floor(remaining / 1000), // segundos
    startTime: new Date(timeoutInfo.startTime).toISOString(),
    senderNumber: timeoutInfo.senderNumber
  };
}


const DDI_TO_TIMEZONE = {
  '1': 'America/New_York',
  '44': 'Europe/London',
  '33': 'Europe/Paris',
  '49': 'Europe/Berlin',
  '34': 'Europe/Madrid',
  '39': 'Europe/Rome',
  '55': 'America/Sao_Paulo',
  '351': 'Europe/Lisbon',
  '54': 'America/Argentina/Buenos_Aires',
  '81': 'Asia/Tokyo',
  '91': 'Asia/Kolkata',
  '61': 'Australia/Sydney',
  '86': 'Asia/Shanghai'
};

/**
 * Extrai número limpo, DDI, timezone e também formata para visualização
 * @param {string} sender - Ex: "5511999999999@c.us"
 * @returns {{ numeroLimpo: string, ddi: string|null, timezone: string|null, numeroFormatado: string }}
 */
function extractPhoneNumberInfo(sender) {
  const raw = sender.split('@')[0]; // "5511999999999"
  const clean = raw.replace(/[^\d]/g, '');

  let ddi = null;
  let timezone = null;

  for (let len of [3, 2, 1]) {
    const code = clean.slice(0, len);
    if (DDI_TO_TIMEZONE[code]) {
      ddi = code;
      timezone = DDI_TO_TIMEZONE[code];
      break;
    }
  }

  const semDDI = clean.slice(ddi?.length || 0);

  let numeroFormatado = `+${ddi} ${semDDI}`;

  // Formatação básica para celular com DDD (como Brasil e EUA)
  if (ddi === '1') {
    // EUA/Canadá: +1 (786) 241-7619
    numeroFormatado = `+${ddi} (${semDDI.slice(0, 3)}) ${semDDI.slice(3, 6)}-${semDDI.slice(6)}`;
  } else if (ddi === '55') {
    // Brasil: +55 (11) 99999-9999
    numeroFormatado = `+${ddi} (${semDDI.slice(0, 2)}) ${semDDI.slice(2, 7)}-${semDDI.slice(7)}`;
  }

  return {
    numeroLimpo: clean,
    ddi,
    timezone,
    numeroFormatado
  };
}

function normalizeToWhatsAppNumber(formatted) {
  const clean = formatted.replace(/\D/g, '');
  return `${clean}@c.us`;
}

function normalizarHorario(input, timezone) {
  const now = DateTime.now().setZone(timezone);
  const str = input.toLowerCase().trim();

  // em X minutos
  const matchMin = str.match(/em\s*(\d+)\s*(min|mins|minuto|minutos)/);
  if (matchMin) {
    return now.plus({ minutes: parseInt(matchMin[1], 10) });
  }

  // formato HH:MM ou HHhMM ou HH MM
  const matchHora = str.match(/(\d{1,2})(?:[:h]\s*(\d{2}))?/);
  if (matchHora) {
    const hora   = parseInt(matchHora[1], 10);
    const minute = matchHora[2] ? parseInt(matchHora[2], 10) : 0;
    return now.set({ hour: hora, minute, second: 0, millisecond: 0 });
  }

  return null;
}


const MAIN_BOT_NUMBER = '14073015137@c.us';
const processingQueues = new Map();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const options = {
  // Certificado padrão (fallback)
  key: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/fullchain.pem'),
  
  // SNI Callback para múltiplos domínios
  SNICallback: (domain, callback) => {
    let keyPath, certPath;
    
    try {
      switch (domain) {
        case 'vcard.thebroker.vip':
          keyPath = '/etc/letsencrypt/live/vcard.thebroker.vip/privkey.pem';
          certPath = '/etc/letsencrypt/live/vcard.thebroker.vip/fullchain.pem';
          break;

        case 'pdf.thebroker.vip':
          keyPath = '/etc/letsencrypt/live/pdf.thebroker.vip/privkey.pem';
          certPath = '/etc/letsencrypt/live/pdf.thebroker.vip/fullchain.pem';
          break;
          
        case 'verbai.com.br':
        default:
          keyPath = '/etc/letsencrypt/live/verbai.com.br/privkey.pem';
          certPath = '/etc/letsencrypt/live/verbai.com.br/fullchain.pem';
          break;
      }
      
      // Verificar se os certificados existem
      if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        console.warn(`Certificados não encontrados para ${domain}, usando padrão`);
        keyPath = '/etc/letsencrypt/live/verbai.com.br/privkey.pem';
        certPath = '/etc/letsencrypt/live/verbai.com.br/fullchain.pem';
      }
      
      const ctx = tls.createSecureContext({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      });
      
      callback(null, ctx);
      
    } catch (error) {
      console.error(`Erro ao carregar certificado para ${domain}:`, error.message);
      
      // Fallback para certificado padrão
      try {
        const defaultCtx = tls.createSecureContext({
          key: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/privkey.pem'),
          cert: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/fullchain.pem')
        });
        callback(null, defaultCtx);
      } catch (fallbackError) {
        callback(fallbackError);
      }
    }
  },
  
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

const VCF_DIR = path.join(__dirname, 'public', 'vcf');
const PDF_DIR = path.join(__dirname, 'public', 'pdf');


const prompt_qualification = fs.readFileSync(path.join(__dirname, 'prompts', 'pre-qualification.txt'), 'utf8');
const server = https.createServer(options, app);
const logStream = fs.createWriteStream('/var/log/wpptalk-errors.log', { flags: 'a' });
server.on('clientError', (err, socket) => {
  const ip = socket.remoteAddress || 'IP desconhecido';
  const linha = `${new Date().toISOString()} | IP: ${ip} | clientError: ${err.message}\n`;
  logStream.write(linha);
  socket.destroy();
});
const wss = new WebSocket.Server({ server });
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const SESSIONS = new Map();
const TOKEN_DIR        = '/root/wpptalk_server/tokens';
const FILTERS_FILE     = path.join(TOKEN_DIR, 'filters', 'filters.json');
const SESSION_LOGS_DIR = path.join(TOKEN_DIR, 'sessions_logs');
const QR_CODES_DIR = path.join(__dirname, 'public', 'qrcodes');
const AUDIO_DIR    = path.join(__dirname, 'audios');

const myTokenStore = new wppconnect.tokenStore.FileTokenStore({
  path: TOKEN_DIR
});

const CONVERSATIONS    = new Map();
const ASSISTANT_MODEL  = "gpt-4.1";
const SESSION_FILTERS = new Map();

[ 
  path.dirname(FILTERS_FILE),
  SESSION_LOGS_DIR,
  QR_CODES_DIR,
  VCF_DIR,
  PDF_DIR,
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
      defaultSrc: ["'self'", "https://verbai.com.br:8443", "https://vcard.thebroker.vip:8443", "https://pdf.thebroker.vip:8443"],
      imgSrc:     ["'self'", "data:", "https://verbai.com.br:8443", "https://vcard.thebroker.vip:8443", "https://pdf.thebroker.vip:8443"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://verbai.com.br:8443", "https://vcard.thebroker.vip:8443", "https://pdf.thebroker.vip:8443"]
    }
  }
}));

app.use((req, res, next) => {
  const allowedOrigins = [
    'https://thebroker.vip',
    'https://verbai.com.br:8443',
    'https://vcard.thebroker.vip:8443',
    'https://pdf.thebroker.vip:8443'
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', 'https://thebroker.vip');
  }
  
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Servir arquivos PDF estáticos
app.use('/pdf', express.static(PDF_DIR));
app.use('/qrcodes', express.static(QR_CODES_DIR));
app.use('/vcf', express.static(VCF_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function getTimezoneFromNumber(number) {
  const clean = number.replace(/\D/g, '');
  const possibleDDIs = [clean.slice(0, 3), clean.slice(0, 2)];
  const ddi = possibleDDIs.find(ddi => DDI_TO_TIMEZONE[ddi]) || '55';

  return DDI_TO_TIMEZONE[ddi] || DDI_TO_TIMEZONE[ddi.slice(0, 2)] || 'UTC';
}


function cleanupOldVCFFiles() {
  try {
    const files = fs.readdirSync(VCF_DIR);
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutos

    files.forEach(file => {
      const filePath = path.join(VCF_DIR, file);
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtime.getTime();
      
      if (fileAge > maxAge) {
        fs.unlinkSync(filePath);
        console.log(`VCF antigo removido: ${file}`);
      }
    });
  } catch (error) {
    console.error('Erro ao limpar arquivos VCF antigos:', error);
  }
}

// Executar limpeza a cada minuto
setInterval(cleanupOldVCFFiles, 60000);

// ===== Rotas e lógica de sessão =====



// no escopo global
let reminderInterval;
/**
 * @param {import('@wppconnect-team/wppconnect').Client} botClient
 */
function startReminderChecks(botClient) {
  // evita múltiplos setInterval
  if (reminderInterval) return;

  const check = async () => {
    const hoje = DateTime.local().toISODate();

    // pega todos os lembretes de hoje
    let rows;
    try {
      [rows] = await pool.query(
        `SELECT numero, titulo, data, hora, local
           FROM lembretes
          WHERE data = ?`,
        [hoje]
      );
    } catch (err) {
      console.error('❌ Erro ao buscar lembretes:', err);
      return;
    }

    for (const ev of rows) {
      const { timezone } = extractPhoneNumberInfo(ev.numero);
      if (!timezone) continue;

      const agora = DateTime.now().setZone(timezone);
      const dtEv  = parseHorario(ev.data, ev.hora, timezone);
      const diff  = Math.round(dtEv.diff(agora, 'minutes').minutes);

      let label;
      if (diff === 10)      label = 'Faltam 10 minutos';
      else if (diff === 5)   label = 'Faltam 5 minutos';
      else if (diff === 0)   label = 'É hora do evento!';
      else continue;

      const msg = `⏰ *${label}* para "${ev.titulo}" em ${ev.local} às ${ev.hora}`;
      try {
        await botClient.sendText(ev.numero, msg);
        console.log(`✔️ [${label}] enviado para ${ev.numero}`);
      } catch (err) {
        console.error(`❌ Falha ao enviar para ${ev.numero}:`, err);
      }
    }
  };

  // primeira execução e depois a cada 60s
  check();
  reminderInterval = setInterval(check, 60_000);
}


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
    // Busca a sessão mais recente com formatação de data no mesmo fuso que foi gravado
    const [rows] = await pool.query(
      `SELECT 
         sessao_numero AS numero,
         DATE_FORMAT(ultimo_acesso, '%Y-%m-%d %H:%i:%s') AS ultimo_acesso
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



// 1. FUNÇÃO PARA EXTRAIR E SALVAR TOKEN MANUALMENTE
const forceTokenSave = async (client, sessionName) => {
  try {
    console.log(`💾 Forçando salvamento de token para ${sessionName}...`);
    
    // Método 1: Usar getSessionTokenBrowser (mais confiável)
    let sessionToken = null;
    
    try {
      sessionToken = await client.getSessionTokenBrowser();
      console.log(`✅ Token extraído via getSessionTokenBrowser para ${sessionName}`);
    } catch (err) {
      console.warn(`⚠️ Falha ao extrair token via getSessionTokenBrowser:`, err.message);
    }
    
    // Método 2: Fallback usando página diretamente
    if (!sessionToken) {
      try {
        sessionToken = await client.page.evaluate(() => {
          // Extrai tokens do localStorage do WhatsApp Web
          const keys = Object.keys(localStorage);
          const tokenData = {};
          
          for (const key of keys) {
            if (key.startsWith('WA') || key.includes('token') || key.includes('session')) {
              try {
                const value = localStorage.getItem(key);
                if (value) {
                  tokenData[key] = JSON.parse(value);
                }
              } catch (e) {
                tokenData[key] = localStorage.getItem(key);
              }
            }
          }
          
          return Object.keys(tokenData).length > 0 ? tokenData : null;
        });
        
        if (sessionToken) {
          console.log(`✅ Token extraído via localStorage para ${sessionName}`);
        }
      } catch (err) {
        console.warn(`⚠️ Falha ao extrair token via localStorage:`, err.message);
      }
    }
    
    // Método 3: Usar getSession interno
    if (!sessionToken) {
      try {
        const session = await client.getSession();
        if (session) {
          sessionToken = session;
          console.log(`✅ Token extraído via getSession para ${sessionName}`);
        }
      } catch (err) {
        console.warn(`⚠️ Falha ao extrair token via getSession:`, err.message);
      }
    }
    
    if (!sessionToken) {
      throw new Error('Não foi possível extrair o token da sessão');
    }
    
    // Salvar token usando o TokenStore
    const saveResult = await myTokenStore.setToken(sessionName, sessionToken);
    
    if (saveResult) {
      console.log(`🎉 Token salvo com sucesso para ${sessionName}`);
      
      // Verificar se o arquivo foi criado
      const savedToken = await myTokenStore.getToken(sessionName);
      if (savedToken) {
        console.log(`✅ Verificação: Token recuperado com sucesso`);
        console.log(`📊 Campos salvos:`, Object.keys(savedToken));
      } else {
        console.warn(`⚠️ Verificação falhou: Token não foi encontrado após salvamento`);
      }
    } else {
      throw new Error('TokenStore retornou false ao salvar');
    }
    
    return true;
    
  } catch (error) {
    console.error(`❌ Erro ao forçar salvamento de token para ${sessionName}:`, error);
    return false;
  }
};


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

    let myNumber = null;

      try {
        await client.isConnected(); // força status válido

        setTimeout(async () => {
          console.log(`🔄 Forçando salvamento do token para sessão ${sessionName}...`);
          await forceTokenSave(client, sessionName);
        }, 5000); // Aguarda 5 segundos para total estabilidade
        
        // // Gera e salva o token manualmente
        // try {
        //   const tokenData = await client.getToken();
        //   if (tokenData) {
        //     await myTokenStore.saveToken(sessionName, tokenData);
        //     console.log(`🔐 Token salvo com sucesso para sessão ${sessionName}`);
        //   }
        // } catch (tokenErr) {
        //   console.warn(`⚠️ Erro ao gerar/salvar token para sessão ${sessionName}:`, tokenErr.message);
        // }

        // Recupera o número real desta sessão
        myNumber = await client.getWid();
        console.log(`📱 Número recuperado imediatamente após criação: ${myNumber}`);

        // Se este número for o do bot principal, disparar checagem de lembretes
        if (myNumber === MAIN_BOT_NUMBER) {
          console.log('▶️ Bot principal conectado — agendando checagem de lembretes...');
          startReminderChecks(client);
        }

        await criarOuIgnorarSessao(sessionName, email);
        console.log(`✅ Sessão ${sessionName} garantida no banco.`);
      } catch (err) {
        console.warn(`⚠️ Falha ao recuperar myNumber após criação da sessão ${sessionName}:`, err.message);
      }


    if (!SESSIONS.has(sessionName)) {
      SESSIONS.set(sessionName, { client, myNumber, email });
    }

    setInterval(async () => {
      try {
        const session = SESSIONS.get(sessionName);
        if (!session) return;

        // obtém o estado atual da conexão
        const state = await session.client.getConnectionState();
        
        // grava no banco
        await atualizarStatusSessao(sessionName, state);
        console.log(`🔄 [${sessionName}] status salvo: ${state}`);
      } catch (err) {
        console.error(`❌ erro ao checar status de ${sessionName}:`, err);
      }
    }, 30_000);

    client.onStateChange(async (state) => {
      try {
        console.log(`Estado da sessão ${sessionName}: ${state}`);

        if (state === 'CONNECTED' || state === 'MAIN') {
          try {
            const myNumber = await client.getWid();
            const session = SESSIONS.get(sessionName);
            if (session) {
              session.myNumber = myNumber;
              console.log(`📱 Número atualizado via onStateChange para sessão ${sessionName}: ${myNumber}`);
            }
          } catch (err) {
            console.error(`❌ Erro ao obter myNumber no onStateChange para sessão ${sessionName}:`, err.message);
          }

          try {
            await criarOuIgnorarSessao(sessionName, email);
            await insertDefaultFilters(email, sessionName);
            console.log(`✅ Sessão '${sessionName}' registrada no banco.`);
          } catch (dbErr) {
            console.error(`❌ Erro ao registrar sessão:`, dbErr);
          }

          broadcastSessionAuthenticated(sessionName);
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
    // ===== DEBUG GERAL PARA TODAS AS MENSAGENS =====
    console.log(`🔍 [MESSAGE-DEBUG] Mensagem recebida - Tipo: ${message.type}`);
    console.log(`🔍 [MESSAGE-DEBUG] From: ${message.from}, To: ${message.to}`);
    
    const filters = await loadFiltersFromDB(email, sessionName);
    SESSION_FILTERS.set(sessionName, filters);

    if (filters.ignoreGroups && message.isGroupMsg) return;
    if (filters.blockedNumbers && filters.blockedNumbers.includes(message.from)) return;

    const session = SESSIONS.get(sessionName);
    if (!session.myNumber) {
      try {
        const wid = await client.getWid();
        if (wid) {
          session.myNumber = wid;
          console.log(`🔁 Número definido dinamicamente via onAnyMessage para ${sessionName}: ${wid}`);
        }
      } catch (e) {
        console.warn(`[onAnyMessage] Falha ao obter myNumber dinâmico para ${sessionName}:`, e.message);
      }
    }

    if (!SESSIONS.get(sessionName)?.myNumber) {
      console.warn(`[onAnyMessage] Ainda sem myNumber para ${sessionName} após tentativa dinâmica.`);
      return;
    }

    if (message.type === 'ptt' || message.type === 'audio') {
      if (message.to === MAIN_BOT_NUMBER) {
        const receivingSession = SESSIONS.get(sessionName);
        if (receivingSession && receivingSession.myNumber === message.to) {
          console.log('🤖 Áudio direcionado ao bot detectado (sessão correta)');
          await processBotAudio(sessionName, message);
        } else {
          console.log('🔄 Áudio para bot detectado, mas processado por outra sessão - ignorando duplicata');
        }
      } else {
        console.log('📱 Áudio normal detectado - processando transcrição');
        enqueueProcessing(sessionName, () => processAudio(sessionName, message));
      }
    }

    if (message.type === 'ciphertext') {
      console.log(`🔐 [DECRYPT] Mensagem ciphertext detectada de ${message.from} — aguardando descriptografia...`);
      const decrypted = await waitForDecryptedMessage(client, message);
      if (!decrypted) {
        console.log(`🗑️ [DECRYPT] Mensagem descartada (não descriptografada): ${message.id}`);
        return; // ignora se não conseguiu
      }
      message = decrypted; // substitui pela versão completa
    }

    // ===== IMAGENS - NOVA LÓGICA PRIORITÁRIA =====
if (message.type === 'image' || message.type === 'IMAGE') {
  console.log(`🔍 [IMAGE-DEBUG] ✅ IMAGEM DETECTADA!`);
  console.log(`🔍 [IMAGE-DEBUG] To: ${message.to}`);
  console.log(`🔍 [IMAGE-DEBUG] From: ${message.from}`);
  console.log(`🔍 [IMAGE-DEBUG] MAIN_BOT_NUMBER: ${MAIN_BOT_NUMBER}`);

  // Verificar se é direcionada ao bot
  if (message.to === MAIN_BOT_NUMBER) {
    console.log(`🔍 [IMAGE-DEBUG] 🤖 Imagem É para o bot!`);
    
    // Verificar se é a sessão correta
    const receivingSession = SESSIONS.get(sessionName);
    if (receivingSession && receivingSession.myNumber === message.to) {
      console.log('🤖 [IMAGE-DEBUG] Imagem direcionada ao bot detectada (sessão correta)');

      const convoKey = `${session.myNumber}:${message.from}`;
      const stored = CONVERSATIONS.get(convoKey);

      console.log(`🔍 [IMAGE-DEBUG] ConvoKey: ${convoKey}`);
      console.log(`🔍 [IMAGE-DEBUG] Stored conversation:`, stored ? {
        activeTrigger: stored.activeTrigger,
        historyLength: stored.history?.length
      } : 'null');

      // ✅ Se há conversa ativa do tbvbusinesscard, mantém o fluxo atual
      if (stored && stored.activeTrigger === 'tbvbusinesscard') {
        console.log('📷 [IMAGE-DEBUG] ✅ Imagem detectada em conversa tbvbusinesscard ativa');
        console.log('📷 [IMAGE-DEBUG] 🚀 Chamando handleTriggerBusinessCard...');
        await handleTriggerBusinessCard(session, message, '', sessionName, email);
        return;
      }

      // ✅ Caso contrário, usa o novo analisador de imagens (processImage)
      console.log('🖼️ [IMAGE-DEBUG] 🚀 Sem conversa tbvbusinesscard ativa — chamando processImage...');
      await processImage(sessionName, message, email);
      return;

    } else {
      console.log('🔄 [IMAGE-DEBUG] Imagem para bot detectada, mas processada por outra sessão - ignorando duplicata');
      return;
    }
  } else {
    // Imagem normal (não direcionada ao bot) — preserva comportamento atual
    console.log('📱 [IMAGE-DEBUG] Imagem NÃO é para o bot - processando como texto normal');
    await processText(sessionName, message, email);
    return;
  }
}

// ===== VERIFICAÇÃO ADICIONAL PARA OUTROS TIPOS DE MÍDIA =====
// (ajuste para NÃO reprocessar imagens; elas já foram tratadas acima)
if (['video', 'sticker', 'VIDEO', 'STICKER'].includes(message.type)) {
  console.log(`🔍 [MESSAGE-DEBUG] Mídia detectada (${message.type}) - processando como texto`);
  await processText(sessionName, message, email);
}


    // ===== VERIFICAÇÃO DE DOCUMENTO COM TIPOS CORRETOS =====
    if (message.type === 'document' || message.type === 'DOCUMENT') {
      console.log(`🔍 [MESSAGE-DEBUG] ✅ DOCUMENTO DETECTADO!`);
      console.log(`🔍 [MESSAGE-DEBUG] Filename: ${message.filename}`);
      console.log(`🔍 [MESSAGE-DEBUG] MimeType: ${message.mimetype}`);
      console.log(`🔍 [MESSAGE-DEBUG] Size: ${message.size}`);
      console.log(`🔍 [MESSAGE-DEBUG] To: ${message.to}`);
      console.log(`🔍 [MESSAGE-DEBUG] From: ${message.from}`);
      console.log(`🔍 [MESSAGE-DEBUG] MAIN_BOT_NUMBER: ${MAIN_BOT_NUMBER}`);

      // ✅ VERIFICAÇÃO: Se documento é direcionado ao BOT
      if (message.to === MAIN_BOT_NUMBER) {
        console.log(`🔍 [MESSAGE-DEBUG] 🤖 Documento É para o bot!`);
        
        // Documento direcionado ao bot - verificar se é a sessão correta
        const receivingSession = SESSIONS.get(sessionName);
        if (receivingSession && receivingSession.myNumber === message.to) {
          console.log('🤖 [MESSAGE-DEBUG] Documento direcionado ao bot detectado (sessão correta)');
          
          const convoKey = `${session.myNumber}:${message.from}`;
          const stored = CONVERSATIONS.get(convoKey);
          
          console.log(`🔍 [MESSAGE-DEBUG] ConvoKey: ${convoKey}`);
          console.log(`🔍 [MESSAGE-DEBUG] Stored conversation:`, stored ? {
            activeTrigger: stored.activeTrigger,
            historyLength: stored.history?.length
          } : 'null');
          
          // Só processar PDF se há conversa ativa do tbvvalidation
          if (stored && stored.activeTrigger === 'tbvvalidation') {
            console.log('📄 [MESSAGE-DEBUG] ✅ Documento PDF detectado em conversa tbvvalidation ativa');
            console.log('📄 [MESSAGE-DEBUG] 🚀 Chamando processPdfDocument...');
            enqueueProcessing(sessionName, () => processPdfDocument(sessionName, message, email));
          } else {
            console.log(`📄 [MESSAGE-DEBUG] ❌ Documento para bot ignorado. Motivo:`);
            console.log(`📄 [MESSAGE-DEBUG] - Stored exists: ${!!stored}`);
            console.log(`📄 [MESSAGE-DEBUG] - Active trigger: ${stored?.activeTrigger || 'none'}`);
            console.log(`📄 [MESSAGE-DEBUG] - Expected: tbvvalidation`);
            
            // Enviar mensagem explicativa se não há conversa ativa
            await client.sendText(message.from, 
              '📄 Para analisar documentos, primeiro ative o assistente enviando "TBV Anti Malandro" ou uma mensagem sobre análise de contratos.'
            );
          }
        } else {
          console.log('🔄 [MESSAGE-DEBUG] Documento para bot detectado, mas processado por outra sessão - ignorando duplicata');
        }
      } else {
        // Documento normal (não direcionado ao bot)
        console.log('📱 [MESSAGE-DEBUG] Documento NÃO é para o bot - processando como texto normal');
        await processText(sessionName, message, email);
      }
    }

    // ===== VERIFICAÇÃO ADICIONAL PARA OUTROS TIPOS DE MÍDIA =====
    if (['image', 'video', 'sticker', 'IMAGE', 'VIDEO', 'STICKER'].includes(message.type)) {
      console.log(`🔍 [MESSAGE-DEBUG] Mídia detectada (${message.type}) - processando como texto`);
      await processText(sessionName, message, email);
    }

  } catch (error) {
    console.error(`❌ [MESSAGE-DEBUG] Erro ao processar mensagem na sessão ${sessionName}:`, error);
    console.error(`❌ [MESSAGE-DEBUG] Stack trace:`, error.stack);
  }
});

  } catch (err) {
    console.error(`❌ Erro ao criar sessão ${sessionName}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro ao iniciar sessão.' });
    }
  }
});


app.post('/add-group', async (req, res) => {

})




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

  // Fluxo especial para blockedNumbers
  if (req.body.hasOwnProperty('blockedNumbers')) {
    try {
      // Garante array de strings
      const novos = (Array.isArray(blockedNumbers) ? blockedNumbers : [blockedNumbers])
        .map(String);

      // Carrega os existentes
      const existentes = await loadBlockedNumbersFromDB(email, sessionName);
      // Filtra apenas os novos
      const soNovos = novos.filter(num => !existentes.includes(num));

      if (soNovos.length === 0) {
        return res.json({
          message: 'Nenhum número novo para adicionar.',
          blockedNumbers: existentes
        });
      }

      // Monta uma linha por número (4 colunas cada)
      const rows = soNovos.map(num => [
        email,
        sessionName,
        'blockedNumbers',
        num
      ]);

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

  // Fluxo para os demais filtros
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
    return res.json({ message: 'Filtros atualizados com sucesso.' });
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

  // Remover QR Code
  const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
  if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath);

  // Remover diretório da sessão
  const sessionPath = path.join(TOKEN_DIR, sessionName);
  setTimeout(() => {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`🧹 Sessão [${sessionName}] removida do sistema de arquivos.`);
    }
  }, 3000);

  // ❗️Nova parte: remover do banco de dados
  try {
    const [result] = await pool.query('DELETE FROM sessoes WHERE numero = ?', [sessionName]);
    if (result.affectedRows > 0) {
      console.log(`🗑️ Sessão [${sessionName}] removida do banco de dados.`);
    } else {
      console.warn(`⚠️ Sessão [${sessionName}] não estava no banco ou já havia sido removida.`);
    }
  } catch (err) {
    console.error(`❌ Erro ao remover sessão ${sessionName} do banco:`, err.message);
  }
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

function parseHorario(dataStr, horaStr, timezone) {
  // Ex: data = '2025-05-20', hora = '15h' ou '15:30'
  let horaFormatada = horaStr.replace('h', ':').trim();
  if (!horaFormatada.includes(':')) horaFormatada += ':00';

  const fullStr = `${dataStr} ${horaFormatada}`;
  return DateTime.fromFormat(fullStr, 'yyyy-MM-dd HH:mm', { zone: timezone });
}

function resolverDataRelativa(dataCampo, timezone) {
  const agora = DateTime.now().setZone(timezone);

  console.log('🧪 [DEBUG] dataCampo original:', JSON.stringify(dataCampo));

  // Garantir que temos uma string
  if (typeof dataCampo !== 'string') {
    dataCampo = String(dataCampo);
    console.log('🧪 [DEBUG] dataCampo convertido para string:', JSON.stringify(dataCampo));
  }

  const normalizada = dataCampo
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s\/\-]/g, '')
    .trim();

  if (normalizada === 'hoje') return agora.startOf('day');
  if (normalizada === 'amanha') return agora.plus({ days: 1 }).startOf('day');

  const diasSemana = {
    segunda: 1, terca: 2, quarta: 3,
    quinta: 4, sexta: 5, sabado: 6, domingo: 7
  };

  if (diasSemana[normalizada]) {
    const alvo = diasSemana[normalizada];
    const atual = agora.weekday;
    const diasParaAdicionar = (alvo + 7 - atual) % 7 || 7;
    return agora.plus({ days: diasParaAdicionar }).startOf('day');
  }

  // yyyy-MM-dd
  const tentativaISO = DateTime.fromISO(normalizada, { zone: timezone });
  if (tentativaISO.isValid) return tentativaISO.startOf('day');

  // Partes como "22", "22/05", "22/05/2025"
  const apenasNumeros = normalizada.match(/\d+/g)?.map(n => parseInt(n)).filter(n => !isNaN(n)) || [];

  console.log('🧪 [DEBUG] apenasNumeros:', apenasNumeros);

  if (apenasNumeros.length === 3) {
    const [dia, mes, ano] = apenasNumeros;
    const dt = DateTime.fromObject({ day: dia, month: mes, year: ano }, { zone: timezone });
    if (dt.isValid) return dt.startOf('day');
  }

  if (apenasNumeros.length === 2) {
    const [dia, mes] = apenasNumeros;
    let ano = agora.year;
    let dt = DateTime.fromObject({ day: dia, month: mes, year: ano }, { zone: timezone });
    if (dt < agora.startOf('day')) dt = dt.plus({ years: 1 });
    if (dt.isValid) return dt.startOf('day');
  }

  // SOLUÇÃO PARA NÚMERO ÚNICO DE DIA
  if (apenasNumeros.length === 1) {
    console.log('🧪 [DEBUG] Processando número único:', apenasNumeros[0]);
    
    const dia = apenasNumeros[0];
    console.log(`🧪 [DEBUG] Comparando: dia ${dia} vs dia atual ${agora.day}`);

    // Verificar se é um dia válido (entre 1 e 31)
    if (dia >= 1 && dia <= 31) {
      let dataResultado;
      
      // Se o dia for maior que o dia atual → é deste mês
      if (dia > agora.day) {
        dataResultado = agora.set({ day: dia });
        console.log(`🧪 [DEBUG] Dia ${dia} > dia atual ${agora.day} → este mês: ${dataResultado.toISODate()}`);
      } 
      // Se o dia for menor ou igual ao dia atual → é do próximo mês
      else {
        dataResultado = agora.plus({ months: 1 }).set({ day: Math.min(dia, agora.plus({ months: 1 }).daysInMonth) });
        console.log(`🧪 [DEBUG] Dia ${dia} <= dia atual ${agora.day} → próximo mês: ${dataResultado.toISODate()}`);
      }
      
      // Validar se o dia existe no mês (evita 31 de fevereiro, etc)
      if (dataResultado.isValid) {
        console.log(`🧪 [DEBUG] Data final escolhida: ${dataResultado.toISODate()}`);
        return dataResultado.startOf('day');
      }
    }
  }

  // Fallback para hoje
  console.log('🧪 [DEBUG] Nenhum padrão reconhecido, usando hoje:', agora.toISODate());
  return agora.startOf('day');
}

function loadPrompt(promptName) {
  const promptPath = path.join(__dirname, 'prompts', `${promptName}.md`);
  return fs.readFileSync(promptPath, 'utf8');
}

async function sendPromptToGPT(promptSystemInstructions, userText) {
  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4.1',
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

// Função auxiliar para forçar UTF-8 (normalização + remoção de caracteres inválidos)
function sanitizeUTF8(str) {
  return typeof str === 'string'
    ? Buffer.from(str, 'utf8').toString('utf8').normalize('NFC').trim()
    : '';
}


// FUNÇÃO handleTBVEventosConversation ORIGINAL + TIMEOUT
async function handleTBVEventosConversation(session, message, userInput, sessionName, email) {
  const client = session.client;
  const sender = message.from;
  const convoKey = `${session.myNumber}:${sender}`;

  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvevents'
  };

  const prompt = loadPrompt('TBVEvents');

  if (convo.history.length === 0) {
    convo.history.push({ role: 'system', content: prompt });
    // ✅ NOVO: Definir timeout quando conversa inicia
    setConversationTimeout(convoKey, session, sender);
  } else {
    // ✅ NOVO: Renovar timeout a cada interação
    refreshConversationTimeout(convoKey, session, sender);
  }

  convo.history.push({ role: 'user', content: userInput });

  const gptResponse = await openai.chat.completions.create({
    model: ASSISTANT_MODEL,
    messages: convo.history,
    temperature: 0.2
  });

  let assistantResponse = gptResponse.choices[0].message.content.trim();
  convo.history.push({ role: 'assistant', content: assistantResponse });

  // Extract JSON without sending it to the user
  let eventoInfo = null;
  let jsonMatch = assistantResponse.match(/```json([\s\S]+?)```/);

  if (!jsonMatch) {
    const fallbackMatch = assistantResponse.match(/json\s*\n?\s*(\{[\s\S]*\})/i);
    if (fallbackMatch) jsonMatch = [null, fallbackMatch[1]];
  }
  if (!jsonMatch) {
    const brute = assistantResponse.match(/\{[\s\S]+?\}/);
    if (brute) jsonMatch = [null, brute[0]];
  }

  let reply = "";
  
  if (jsonMatch) {
    try {
      eventoInfo = JSON.parse(jsonMatch[1]);

      if (!eventoInfo.data || !eventoInfo.data.trim()) {
      eventoInfo.data = 'hoje';
      }


      const camposObrigatorios = ['titulo', 'data', 'hora'];
      const completo = camposObrigatorios.every(k => eventoInfo[k] && eventoInfo[k].trim() !== '');

      if (completo) {
        const { timezone, numeroFormatado } = extractPhoneNumberInfo(sender);
        if (!timezone) {
          reply = `⚠️ Não foi possível identificar seu fuso horário pelo número ${numeroFormatado}.`;
          await client.sendText(sender, reply);
          CONVERSATIONS.set(convoKey, convo);
          return;
        }

        const agora = DateTime.now().setZone(timezone);
        const dataInterna = resolverDataRelativa(eventoInfo.data, timezone);
        const horaInterna = normalizarHorario(eventoInfo.hora, timezone)?.set({
          year: dataInterna.year,
          month: dataInterna.month,
          day: dataInterna.day
        });

        if (!horaInterna || !horaInterna.isValid) {
          reply = `⚠️ O horário informado ("${eventoInfo.hora}") é inválido. Use formatos como "18h", "18:30", ou "em 20min".`;
          await client.sendText(sender, reply);
          CONVERSATIONS.set(convoKey, convo);
          return;
        }

        console.log('🕒 [DEBUG] Agora:', agora.toISO());
        console.log('📝 [DEBUG] Data original (eventoInfo.data):', eventoInfo.data);
        console.log('📝 [DEBUG] Hora original (eventoInfo.hora):', eventoInfo.hora);
        console.log('📅 [DEBUG] Data interpretada (dataInterna):', dataInterna.toISODate());
        console.log('⏰ [DEBUG] Hora interpretada (horaInterna):', horaInterna.toISO());

        // Evita falsos positivos em eventos futuros
        if (horaInterna < agora.minus({ minutes: 1 })) {
          reply = `⏰ O horário informado (${eventoInfo.data} às ${eventoInfo.hora}) já passou no seu fuso horário (${timezone}).\n` +
            `Deseja agendar para o dia seguinte no mesmo horário? Responda "sim" ou informe um novo horário.`;
          await client.sendText(sender, reply);
          CONVERSATIONS.set(convoKey, convo);
          return;
        }

        // Prepare a clean user-facing message without JSON
        const horaFormatada = horaInterna.toFormat('HH:mm');
        const dataFormatada = horaInterna.toFormat('dd/MM/yyyy');

        await saveEventoToDB(sender, {
          titulo: sanitizeUTF8(eventoInfo.titulo),
          data: horaInterna.toISODate(),
          hora: horaInterna.toFormat('HH:mm'),
          local: sanitizeUTF8(eventoInfo.local || ''),
          observacoes: sanitizeUTF8(eventoInfo.observacoes || '')
        });

        reply = [
          `📋 *Evento agendado com sucesso!*`,
          `1. *Título:* ${eventoInfo.titulo || 'Não informado'}`,
          `2. *Data:* ${dataFormatada}`,
          `3. *Hora:* ${horaFormatada}`,
          `4. *Local:* ${eventoInfo.local?.trim() || 'Não informado'}`,
          `5. *Observações:* ${eventoInfo.observacoes?.trim() || 'Nenhuma'}`
        ].join('\n');

        await client.sendText(sender, reply);

        // ✅ NOVO: Limpar timeout quando conversa termina
        clearConversationTimeout(convoKey);
        CONVERSATIONS.delete(convoKey);

        return;

        
      }
    } catch (err) {
      console.warn('⚠️ Falha ao interpretar JSON do GPT:', err.message);
      
      // Fallback em caso de erro de parsing
      reply = "Desculpe, tive um problema ao processar sua solicitação. Poderia fornecer mais detalhes sobre o evento que gostaria de agendar?";
    }
  } else {
    // Se não encontrou JSON, use a resposta do assistente mas remova qualquer trecho que pareça JSON
    reply = assistantResponse
      .replace(/```json[\s\S]*?```/gi, '')
      .replace(/json\s*\n?\s*(\{[\s\S]*\})/gi, '')
      .replace(/\{[\s\S]*?\}/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim();
      
    // Se a resposta ficar muito curta após a limpeza
    if (reply.length < 20) {
      reply = "Poderia fornecer mais detalhes sobre o evento que deseja agendar? Preciso do título, data e hora do evento.";
    }
  }

  CONVERSATIONS.set(convoKey, convo);
  await client.sendText(sender, reply);
}


async function handleTriggerBusinessCard(session, message, userInput, sessionName, email) {
  const client   = session.client;
  const sender   = message.from;
  const convoKey = `${session.myNumber}:${sender}`;

  console.log(`📷 [BUSINESS-CARD] Processando mensagem tipo: ${message.type}`);
  console.log(`📷 [BUSINESS-CARD] UserInput: "${userInput}"`);

  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvbusinesscard',
    imageData: null,
    extractedData: null,
    waitingForConfirmation: false
  };

  const prompt = loadPrompt('TBVBusinessCard');

  if (convo.history.length === 0) {
    convo.history.push({ role: 'system', content: prompt });
    setConversationTimeout(convoKey, session, sender);

    await client.sendText(sender, 
      '🎯 *Digitalizador de Cartões de Visita Pro*\n\n' +
      '📸 Envie uma foto clara do cartão de visita para digitalizar.'
    );
    
    CONVERSATIONS.set(convoKey, convo);
    return;
  } else {
    refreshConversationTimeout(convoKey, session, sender);
  }

  if (convo.waitingForConfirmation) {
    const userResponse = userInput.toLowerCase().trim();
    
    if (['não', 'nao', 'cancelar', 'parar', 'tchau', 'não quero mais'].includes(userResponse)) {
      await client.sendText(sender, 'finalizando-digitalizacao');
      clearConversationTimeout(convoKey);
      CONVERSATIONS.delete(convoKey);
      return;
    }
    
    if (userResponse === 'sim') {
      try {
        console.log('🔄 [VCF] Iniciando geração do VCF...');
        console.log('📋 [VCF] Dados extraídos:', JSON.stringify(convo.extractedData));
        
        await generateAndSendVCF(client, sender, convo.extractedData);
        
        setTimeout(async () => {
          await client.sendText(sender, 
            '✅ Digitalização concluída!\n\n' +
            '🔄 Deseja digitalizar outro cartão? Envie uma nova foto!'
          );
        }, 2000);
        
        convo.waitingForConfirmation = false;
        convo.extractedData = null;
        convo.imageData = null;
        CONVERSATIONS.set(convoKey, convo);
        return;
        
      } catch (vcfError) {
        console.error('❌ [VCF] Erro ao gerar VCF:', vcfError);
        await client.sendText(sender, '❌ Erro ao gerar arquivo de contato. Tente novamente.');
        return;
      }
      
    } else if (userResponse === 'corrigir') {
      await client.sendText(sender, 
        '✏️ *Por favor, indique qual campo deseja corrigir e a informação correta.*\n\n' +
        '📝 Exemplo: "E-mail correto é joao@empresa.com"'
      );
      convo.waitingForConfirmation = false;
      CONVERSATIONS.set(convoKey, convo);
      return;
    }
  }

  if (message.type === 'image' || message.mimetype?.startsWith('image/')) {
    try {
      console.log('📸 [IMAGE] Processando imagem...');
      const imageBuffer = await client.decryptFile(message);
      const base64Image = imageBuffer.toString('base64');
      convo.imageData = base64Image;

      const extractionPrompt = `
Analise esta imagem de cartão de visita e extraia TODOS os dados visíveis em formato JSON.

Retorne APENAS um objeto JSON com esta estrutura:
{
  "nome": "Nome da pessoa",
  "cargo": "Cargo/Função",
  "empresa": "Nome da empresa",
  "celular": "Celular formatado como +55 XX XXXXX-XXXX",
  "telefone": "Telefone fixo formatado como +55 XX XXXX-XXXX",
  "email": "E-mail",
  "website": "Website/URL",
  "endereco": "Endereço completo",
  "linkedin": "LinkedIn ou redes sociais"
}

Se algum campo não estiver visível ou legível, use "Não informado".
Para telefones brasileiros, sempre inclua o código +55.
`;
      console.log('🤖 [GPT] Enviando para API...');
      const gptResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: extractionPrompt },
              { 
                type: 'image_url', 
                image_url: { 
                  url: `data:${message.mimetype};base64,${base64Image}` 
                } 
              }
            ]
          }
        ],
        max_tokens: 1000
      }, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      console.log('✅ [GPT] Resposta recebida');
      let assistantResponse = gptResponse.data.choices[0].message.content;

      const jsonMatch = assistantResponse.match(/\{[\s\S]*\}/);
      const extractedData = JSON.parse(jsonMatch[0]);
      console.log('📋 [EXTRACTED] Dados extraídos:', JSON.stringify(extractedData));

      convo.extractedData = extractedData;

      const validationTable = generateValidationTable(extractedData);
      await client.sendText(sender, validationTable + '\n\n📝 Todos os dados estão corretos? Digite **SIM** ou **CORRIGIR**');

      convo.waitingForConfirmation = true;
      
    } catch (imageError) {
      console.error('❌ [IMAGE] Erro ao processar imagem:', imageError);
      await client.sendText(sender, '❌ Erro ao processar a imagem. Tente novamente.');
      return;
    }
  }

  CONVERSATIONS.set(convoKey, convo);
}

// Adicione esta função antes da função generateAndSendVCF

function generateValidationTable(data) {
  let table = '📋 *Dados Extraídos do Cartão:*\n\n';
  
  if (data.nome && data.nome !== 'Não informado') {
    table += `👤 *Nome:* ${data.nome}\n`;
  }
  
  if (data.cargo && data.cargo !== 'Não informado') {
    table += `💼 *Cargo:* ${data.cargo}\n`;
  }
  
  if (data.empresa && data.empresa !== 'Não informado') {
    table += `🏢 *Empresa:* ${data.empresa}\n`;
  }
  
  if (data.celular && data.celular !== 'Não informado') {
    table += `📱 *Celular:* ${data.celular}\n`;
  }
  
  if (data.telefone && data.telefone !== 'Não informado') {
    table += `☎️ *Telefone:* ${data.telefone}\n`;
  }
  
  if (data.email && data.email !== 'Não informado') {
    table += `📧 *E-mail:* ${data.email}\n`;
  }
  
  if (data.website && data.website !== 'Não informado') {
    table += `🌐 *Website:* ${data.website}\n`;
  }
  
  if (data.endereco && data.endereco !== 'Não informado') {
    table += `📍 *Endereço:* ${data.endereco}\n`;
  }
  
  if (data.linkedin && data.linkedin !== 'Não informado') {
    table += `🔗 *LinkedIn:* ${data.linkedin}\n`;
  }
  
  return table;
}

function splitFullName(fullName) {
  const nameParts = fullName.trim().split(' ');
  
  if (nameParts.length === 1) {
    return {
      given: nameParts[0],
      family: ''
    };
  }
  
  // Último nome é o sobrenome, o resto é o nome
  const family = nameParts.pop();
  const given = nameParts.join(' ');
  
  return {
    given: given,
    family: family
  };
}

async function generateAndSendVCF(client, sender, data) {
  try {
    console.log('🔨 [VCF] Construindo conteúdo VCF...');
    let vcfContent = 'BEGIN:VCARD\nVERSION:3.0\n';
    
    // CORREÇÃO APLICADA AQUI: Adicionado CHARSET=UTF-8 e formatado corretamente o campo N
    if (data.nome && data.nome !== 'Não informado') {
      console.log('👤 [VCF] Processando nome:', data.nome);
      const { given, family } = splitFullName(data.nome);
      console.log('👤 [VCF] Nome dividido - Given:', given, '| Family:', family);

      vcfContent += `FN;CHARSET=UTF-8:${data.nome}\n`;
      vcfContent += `N;CHARSET=UTF-8:${family};${given};;;\n`;
    }
    
    if (data.cargo && data.cargo !== 'Não informado') {
      vcfContent += `TITLE:${data.cargo}\n`;
    }
    
    if (data.empresa && data.empresa !== 'Não informado') {
      vcfContent += `ORG:${data.empresa}\n`;
    }
    
    if (data.celular && data.celular !== 'Não informado') {
      vcfContent += `TEL;TYPE=CELL:${data.celular}\n`;
    }
    
    if (data.telefone && data.telefone !== 'Não informado') {
      vcfContent += `TEL;TYPE=WORK:${data.telefone}\n`;
    }
    
    if (data.email && data.email !== 'Não informado') {
      vcfContent += `EMAIL:${data.email}\n`;
    }
    
    if (data.website && data.website !== 'Não informado') {
      vcfContent += `URL:${data.website}\n`;
    }
    
    if (data.endereco && data.endereco !== 'Não informado') {
      vcfContent += `ADR:;;${data.endereco};;;;\n`;
    }
    
    if (data.linkedin && data.linkedin !== 'Não informado') {
      vcfContent += `URL:${data.linkedin}\n`;
    }
    
    vcfContent += 'END:VCARD';

    console.log('💾 [VCF] Salvando arquivo...');
    const baseName = data.nome ? data.nome.replace(/\s+/g, '_') : 'contato';
    const fileName = `${baseName}_${Date.now()}.vcf`;
    const filePath = path.join(__dirname, 'public', 'vcf', fileName);

    if (!fs.existsSync(path.dirname(filePath))) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    fs.writeFileSync(filePath, vcfContent, 'utf-8');
    console.log('✅ [VCF] Arquivo salvo:', filePath);

    const downloadLink = `https://vcard.thebroker.vip:8443/vcf/${fileName}`;

    await client.sendText(sender, 
      `🎉 **Arquivo VCF gerado com sucesso!**\n\n🔗 ${downloadLink}`
    );
    
    console.log('✅ [VCF] Processo completo!');

  } catch (error) {
    console.error('❌ [VCF] Erro detalhado:', error);
    await client.sendText(sender, '❌ Erro ao gerar arquivo de contato.');
    throw error; // Re-throw para o catch acima capturar
  }
}

async function buscarCambioBCB(dataInicial = null, maxTentativas = 7) {
    // Se não foi passada uma data, usar hoje
    let dataAtual = dataInicial ? new Date(dataInicial) : new Date();
    let tentativas = 0;
    
    while (tentativas < maxTentativas) {
        try {
            // Formatar a data no formato MM-DD-YYYY
            const mes = String(dataAtual.getMonth() + 1).padStart(2, '0');
            const dia = String(dataAtual.getDate()).padStart(2, '0');
            const ano = dataAtual.getFullYear();
            const dataFormatada = `${mes}-${dia}-${ano}`;
            
            // Montar a URL
            const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaDia(moeda=@moeda,dataCotacao=@dataCotacao)?%40moeda='USD'&%40dataCotacao='${dataFormatada}'&%24orderby=dataHoraCotacao%20asc&%24top=100&%24select=cotacaoCompra,cotacaoVenda,dataHoraCotacao,tipoBoletim&%24format=json`;
            
            // Fazer a requisição
            const response = await fetch(url);
            const data = await response.json();
            
            // Verificar se tem dados
            if (data.value && data.value.length > 0) {
                // Pegar a última cotação disponível (geralmente o fechamento)
                const ultimaCotacao = data.value[data.value.length - 1];
                
                return {
                    sucesso: true,
                    data: dataFormatada,
                    cotacaoVenda: ultimaCotacao.cotacaoVenda,
                    cotacaoCompra: ultimaCotacao.cotacaoCompra,
                    dataHoraCotacao: ultimaCotacao.dataHoraCotacao,
                    tipoBoletim: ultimaCotacao.tipoBoletim,
                    todasCotacoes: data.value // Caso precise ver todas as cotações do dia
                };
            }
            
            // Se não tem dados, voltar um dia
            tentativas++;
            dataAtual.setDate(dataAtual.getDate() - 1);
            
        } catch (error) {
            console.error('Erro ao buscar cotação:', error);
            tentativas++;
            dataAtual.setDate(dataAtual.getDate() - 1);
        }
    }
    
    // Se não encontrou em nenhum dos dias
    return {
        sucesso: false,
        erro: 'Não foi possível encontrar cotação nos últimos ' + maxTentativas + ' dias'
    };
}

/**
 * Versão simplificada que retorna apenas o valor da cotação de venda
 * @param {Date|string} data - Data para buscar (opcional)
 * @returns {number|null} Valor da cotação de venda ou null se não encontrar
 */
async function obterCotacaoVenda(data = null) {
    const resultado = await buscarCambioBCB(data);
    return resultado.sucesso ? resultado.cotacaoVenda : null;
}

async function handleTriggerEsperarDolar(session, message, userInput, sessionName, email) {
  const client   = session.client;
  const sender   = message.from;
  const convoKey = `${session.myNumber}:${sender}`;
  
  // Inicia ou recupera o estado da conversa
  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvesperardolar'
  };
  
  // Se for a primeira interação, injeta o system prompt
  if (convo.history.length === 0) {
    // Carrega o prompt "EsperarDolar"
    const prompt = loadPrompt('tbvdolar');
    
    // MODIFICADO: Removido instruções sobre incluir o link do PDF
    const fullSystemPrompt = `${prompt}

Você tem acesso a duas funções principais:

1. buscarCambioBCB(data) - busca a cotação do dólar no Banco Central. 
   - Se data for null, busca a cotação mais recente
   - Retorna objeto com: sucesso, data, cotacaoVenda, cotacaoCompra, tipoBoletim
   - A API do BCB pode não ter dados em fins de semana/feriados

2. calcularCustoEsperar(inputs) - calcula se vale a pena esperar o câmbio cair
   - Parâmetros obrigatórios: V0, m, FX0, FXbuy
   - Parâmetros opcionais: r, g, y, dp

Quando o usuário não souber o câmbio atual, use buscarCambioBCB() para obter a cotação oficial.
Quando tiver todos os dados necessários, use calcularCustoEsperar.

IMPORTANTE: Apresente os resultados de forma clara e profissional, mas NÃO mencione nada sobre PDF ou relatório completo. Apenas forneça a análise detalhada dos números.`;
    
    // Adiciona apenas UMA mensagem system
    convo.history.push({ role: 'system', content: fullSystemPrompt });
    
    // Definir timeout quando conversa inicia
    setConversationTimeout(convoKey, session, sender);
  } else {
    // Renovar timeout a cada interação
    refreshConversationTimeout(convoKey, session, sender);
  }
  
  // Empilha a mensagem do usuário
  convo.history.push({ role: 'user', content: userInput });
  
  // Chama o GPT com capacidade de function calling
  const gptResponse = await openai.chat.completions.create({
    model: ASSISTANT_MODEL,
    messages: convo.history,
    temperature: 0.2,
    functions: [
      {
        name: "buscarCambioBCB",
        description: "Busca a cotação atual do dólar no Banco Central do Brasil",
        parameters: {
          type: "object",
          properties: {
            data: { 
              type: "string", 
              description: "Data para buscar cotação (formato YYYY-MM-DD). Se null, busca a mais recente.",
              nullable: true
            }
          }
        }
      },
      {
        name: "calcularCustoEsperar",
        description: "Calcula se vale a pena esperar o câmbio cair para comprar um imóvel",
        parameters: {
          type: "object",
          properties: {
            V0: { type: "number", description: "Valor do imóvel em USD" },
            m: { type: "number", description: "Meses de espera" },
            FX0: { type: "number", description: "Câmbio atual R$/USD" },
            FXbuy: { type: "number", description: "Câmbio futuro esperado R$/USD" },
            r: { type: "number", description: "Taxa de aplicação anual (opcional)" },
            g: { type: "number", description: "Valorização anual do imóvel (opcional)" },
            y: { type: "number", description: "Yield anual do imóvel (opcional)" },
            dp: { type: "number", description: "Percentual de downpayment (opcional)" }
          },
          required: ["V0", "m", "FX0", "FXbuy"]
        }
      }
    ],
    function_call: "auto"
  });
  
  const responseMessage = gptResponse.choices[0].message;
  
  // Se o GPT chamou uma função
  if (responseMessage.function_call) {
    const functionName = responseMessage.function_call.name;
    const functionArgs = JSON.parse(responseMessage.function_call.arguments);
    
    if (functionName === "buscarCambioBCB") {
      try {
        // Busca a cotação do dólar usando a função existente
        const cotacao = await buscarCambioBCB(functionArgs.data);
        
        // Adiciona o resultado à conversa
        convo.history.push({
          role: 'function',
          name: 'buscarCambioBCB',
          content: JSON.stringify(cotacao)
        });
        
        // Continua a conversa com o resultado da cotação
        const continuationResponse = await openai.chat.completions.create({
          model: ASSISTANT_MODEL,
          messages: convo.history,
          temperature: 0.2,
          functions: [
            {
              name: "calcularCustoEsperar",
              description: "Calcula se vale a pena esperar o câmbio cair para comprar um imóvel",
              parameters: {
                type: "object",
                properties: {
                  V0: { type: "number", description: "Valor do imóvel em USD" },
                  m: { type: "number", description: "Meses de espera" },
                  FX0: { type: "number", description: "Câmbio atual R$/USD" },
                  FXbuy: { type: "number", description: "Câmbio futuro esperado R$/USD" },
                  r: { type: "number", description: "Taxa de aplicação anual (opcional)" },
                  g: { type: "number", description: "Valorização anual do imóvel (opcional)" },
                  y: { type: "number", description: "Yield anual do imóvel (opcional)" },
                  dp: { type: "number", description: "Percentual de downpayment (opcional)" }
                },
                required: ["V0", "m", "FX0", "FXbuy"]
              }
            }
          ],
          function_call: "auto"
        });
        
        // Processa a resposta recursivamente
        responseMessage.content = continuationResponse.choices[0].message.content;
        responseMessage.function_call = continuationResponse.choices[0].message.function_call;
        
      } catch (error) {
        console.error('Erro ao buscar cotação BCB:', error);
        
        // Se falhar, informa o usuário
        convo.history.push({
          role: 'function',
          name: 'buscarCambioBCB',
          content: JSON.stringify({
            sucesso: false,
            erro: 'Não foi possível buscar a cotação do BCB. Por favor, informe o câmbio atual manualmente.'
          })
        });
        
        // Continua a conversa
        const errorResponse = await openai.chat.completions.create({
          model: ASSISTANT_MODEL,
          messages: convo.history,
          temperature: 0.2
        });
        
        const assistantResponse = errorResponse.choices[0].message.content.trim();
        convo.history.push({ role: 'assistant', content: assistantResponse });
        
        await client.sendText(sender, assistantResponse);
        CONVERSATIONS.set(convoKey, convo);
        return;
      }
    }
    
    if (functionName === "calcularCustoEsperar" || responseMessage.function_call?.name === "calcularCustoEsperar") {
      // Se for a função de cálculo
      const args = functionName === "calcularCustoEsperar" ? functionArgs : JSON.parse(responseMessage.function_call.arguments);
      
      let pdfInfo = null;
      
      try {
        // Executa a função de cálculo
        const resultado = calcularCustoEsperar(args);
        
        // Gera o PDF com os resultados
        pdfInfo = await gerarPDFCambio(resultado, args);
        
        // MODIFICADO: Não incluímos mais o PDF no resultado enviado ao GPT
        convo.history.push({
          role: 'function',
          name: 'calcularCustoEsperar',
          content: JSON.stringify(resultado)
        });
        
        // Pede ao GPT para formatar a resposta baseada no resultado
        // MODIFICADO: Adiciona instrução explícita para apenas formatar o JSON
        convo.history.push({
          role: 'system',
          content: `INSTRUÇÃO CRÍTICA: 
          
Você recebeu um JSON com os resultados já calculados. Sua ÚNICA tarefa é apresentar esses valores de forma organizada e clara.

REGRAS OBRIGATÓRIAS:
1. NÃO faça NENHUM cálculo próprio
2. NÃO modifique NENHUM valor recebido
3. NÃO calcule percentuais, diferenças ou qualquer operação matemática
4. NÃO interprete ou valide os números
5. Use APENAS os valores exatos do JSON recebido
6. NÃO mencione PDF ou relatório

Formato EXATO para apresentação:

📊 **ANÁLISE DO CUSTO DE ESPERAR O CÂMBIO**

**Cenário Analisado:**
• Imóvel de US$ [use o valor de parametros.valor_imovel_USD]
• Espera de [use parametros.meses_espera] meses
• Câmbio: R$ [use parametros.cambio_atual] → R$ [use parametros.cambio_futuro]

**RESULTADO: [Se resultado.BRL > 0 escreva "Ganho", senão "Perda"] de R$ [use resultado.BRL] (US$ [use resultado.USD])**

✅ **GANHOS AO ESPERAR:**
• Rendimento no Brasil: R$ [use ganhos.aplicacao.rendimento_BRL]
• Economia no câmbio: R$ [use ganhos.cambio.ganho_BRL]
• Total de ganhos: R$ [use ganhos.total]

❌ **PERDAS POR ESPERAR:**
• Valorização perdida: R$ [use perdas.valorizacao.BRL] (US$ [use perdas.valorizacao.USD])
• Aluguel não recebido: R$ [use perdas.yield.BRL] (US$ [use perdas.yield.USD])
• Total de perdas: R$ [use perdas.total]

💡 **CONCLUSÃO:**
[Se resultado.BRL < 0]: Esperar resultaria em uma perda líquida. O custo de oportunidade supera a economia no câmbio.
[Se resultado.BRL > 0]: Esperar resultaria em um ganho líquido. A economia no câmbio compensa o custo de oportunidade.

Lembre-se: use APENAS os valores do JSON, sem fazer nenhum cálculo ou modificação.`
        });
        
        const formattedResponse = await openai.chat.completions.create({
          model: ASSISTANT_MODEL,
          messages: convo.history,
          temperature: 0.1  // Temperatura baixa para menor variação
        });
        
        const assistantResponse = formattedResponse.choices[0].message.content.trim();
        convo.history.push({ role: 'assistant', content: assistantResponse });
        
        // Se o GPT devolveu o token de encerramento
        if (assistantResponse === 'finalizando-atendimento') {
          await client.sendText(
            sender,
            '👍 Até mais! Quando quiser fazer uma nova análise, é só digitar o gatilho novamente.'
          );
          clearConversationTimeout(convoKey);
          CONVERSATIONS.delete(convoKey);
          return;
        }
        
        // Envia a resposta do GPT
        await client.sendText(sender, assistantResponse);
        
        // NOVO: Envia o link do PDF manualmente após a resposta do GPT
        if (pdfInfo && pdfInfo.url) {
          const pdfMessage = `💹 **RELATÓRIO COMPLETO EM PDF**

Preparei um relatório visual detalhado com gráficos comparativos da análise de câmbio.

🔗 **Acesse aqui:** ${pdfInfo.url}

⏰ *Link válido até ${new Date(pdfInfo.validade).toLocaleTimeString('pt-BR')} (5 minutos)*

💡 Dica: Salve o PDF para consultas futuras sobre sua decisão de investimento!`;
          
          // Aguarda um pequeno delay para melhor UX
          await new Promise(resolve => setTimeout(resolve, 1500));
          
          // Envia a mensagem com o link do PDF
          await client.sendText(sender, pdfMessage);
        }
        
      } catch (error) {
        console.error('Erro ao processar cálculo ou gerar PDF:', error);
        
        // Se houve erro na geração do PDF, ainda envia a resposta do GPT
        if (!pdfInfo) {
          await client.sendText(
            sender,
            '⚠️ Não consegui gerar o PDF com o relatório visual, mas a análise acima está completa com todos os dados necessários para sua decisão.'
          );
        }
      }
    }
  } else {
    // Resposta normal sem chamar função
    const assistantResponse = responseMessage.content.trim();
    convo.history.push({ role: 'assistant', content: assistantResponse });
    
    // Se o GPT devolveu o token de encerramento
    if (assistantResponse === 'finalizando-atendimento') {
      await client.sendText(
        sender,
        '👍 Até mais! Quando quiser fazer uma nova análise, é só digitar o gatilho novamente.'
      );
      clearConversationTimeout(convoKey);
      CONVERSATIONS.delete(convoKey);
      return;
    }
    
    await client.sendText(sender, assistantResponse);
  }
  
  // Salva o estado da conversa
  CONVERSATIONS.set(convoKey, convo);
}

// Função para gerar o PDF de câmbio (mantida sem alterações)
async function gerarPDFCambio(resultado, inputs) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    // HTML com design profissional
    const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', Arial, sans-serif;
            background-color: #1a1a1a;
            color: #ffffff;
            line-height: 1.6;
        }
        
        .page {
            max-width: 1200px;
            margin: 0 auto;
            background-color: #ffffff;
            min-height: 100vh;
        }
        
        /* Header */
        .header {
            background-color: #000000;
            color: #ffffff;
            padding: 30px 40px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .header h1 {
            font-size: 32px;
            font-weight: 700;
            letter-spacing: -1px;
        }
        
        .logo {
            font-size: 18px;
            font-weight: 600;
            text-align: right;
        }
        
        /* Subtitle Bar */
        .subtitle-bar {
            background-color: #e91e63;
            color: #ffffff;
            padding: 10px 40px;
            font-size: 14px;
            font-weight: 600;
        }
        
        /* Exchange Rate Display */
        .cambio-section {
            background-color: #000;
            color: #fff;
            padding: 30px 40px;
            text-align: center;
        }
        
        .cambio-grid {
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            gap: 30px;
            max-width: 800px;
            margin: 0 auto;
        }
        
        .cambio-card {
            background-color: #1a1a1a;
            padding: 20px;
            border-radius: 8px;
            border: 2px solid #333;
        }
        
        .cambio-label {
            font-size: 12px;
            color: #ccc;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 10px;
        }
        
        .cambio-value {
            font-size: 36px;
            font-weight: 700;
            color: #e91e63;
        }
        
        .cambio-arrow {
            font-size: 48px;
            color: #e91e63;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        /* Main Content */
        .main-content {
            display: grid;
            grid-template-columns: 1fr 2fr;
            gap: 30px;
            padding: 30px 40px;
            background-color: #f5f5f5;
        }
        
        /* Left Section */
        .left-section {
            background-color: #ffffff;
            padding: 25px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        
        .section-title {
            background-color: #e91e63;
            color: #ffffff;
            padding: 10px 15px;
            margin: -25px -25px 20px -25px;
            font-size: 16px;
            font-weight: 600;
            border-radius: 8px 8px 0 0;
        }
        
        .data-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #f0f0f0;
        }
        
        .data-row:last-child {
            border-bottom: none;
        }
        
        .data-label {
            font-size: 13px;
            color: #666;
        }
        
        .data-value {
            font-size: 14px;
            font-weight: 600;
            color: #333;
        }
        
        .total-row {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 2px solid #e91e63;
        }
        
        .total-row .data-label {
            font-weight: 700;
            color: #333;
        }
        
        .total-row .data-value {
            font-size: 16px;
            color: #e91e63;
        }
        
        /* Right Section - Metrics */
        .right-section {
            background-color: #000000;
            padding: 30px;
            border-radius: 8px;
            color: #ffffff;
        }
        
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 25px;
            margin-bottom: 30px;
        }
        
        .metric-circle {
            text-align: center;
        }
        
        .circle-container {
            width: 120px;
            height: 120px;
            margin: 0 auto 10px;
            position: relative;
        }
        
        .circle-bg {
            width: 100%;
            height: 100%;
            border-radius: 50%;
            border: 8px solid #333;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-direction: column;
        }
        
        .circle-positive {
            border-color: #4caf50;
        }
        
        .circle-negative {
            border-color: #e91e63;
        }
        
        .circle-value {
            font-size: 20px;
            font-weight: 700;
        }
        
        .circle-label {
            font-size: 11px;
            color: #ccc;
            margin-top: 5px;
        }
        
        .metric-title {
            font-size: 14px;
            color: #ccc;
            font-weight: 600;
        }
        
        /* Result Section */
        .result-section {
            background-color: #ffffff;
            margin: 0 40px 30px;
            padding: 25px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            text-align: center;
        }
        
        .result-positive {
            border: 3px solid #4caf50;
        }
        
        .result-negative {
            border: 3px solid #e91e63;
        }
        
        .result-title {
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 10px;
            color: #333;
        }
        
        .result-value {
            font-size: 36px;
            font-weight: 700;
            margin-bottom: 5px;
        }
        
        .result-value-usd {
            font-size: 24px;
            font-weight: 600;
            color: #666;
            margin-bottom: 15px;
        }
        
        .result-positive .result-value {
            color: #4caf50;
        }
        
        .result-negative .result-value {
            color: #e91e63;
        }
        
        .result-description {
            font-size: 14px;
            color: #666;
            line-height: 1.6;
        }
        
        /* Footer */
        .footer {
            background-color: #000;
            color: #ffffff;
            padding: 30px 40px;
            text-align: center;
        }
        
        .footer-brand {
            font-size: 18px;
            font-weight: 700;
            margin-bottom: 10px;
        }
        
        .footer-info {
            font-size: 12px;
            color: #ccc;
        }
    </style>
</head>
<body>
    <div class="page">
        <!-- Header -->
        <div class="header">
            <h1>ANÁLISE ESPERAR O CÂMBIO CAIR</h1>
            <div class="logo">THE FLORIDA<br>LOUNGE</div>
        </div>
        
        <!-- Subtitle -->
        <div class="subtitle-bar">
            IMÓVEL: ${formatCurrencyUSD(inputs.V0)} | ESPERA: ${inputs.m} MESES | CÂMBIO: R$ ${inputs.FX0.toFixed(2)} → R$ ${inputs.FXbuy.toFixed(2)}
        </div>
        
        <!-- Exchange Rate Display -->
        <div class="cambio-section">
            <div class="cambio-grid">
                <div class="cambio-card">
                    <div class="cambio-label">Câmbio Atual</div>
                    <div class="cambio-value">R$ ${inputs.FX0.toFixed(2).replace('.', ',')}</div>
                </div>
                <div class="cambio-arrow">→</div>
                <div class="cambio-card">
                    <div class="cambio-label">Câmbio Esperado</div>
                    <div class="cambio-value">R$ ${inputs.FXbuy.toFixed(2).replace('.', ',')}</div>
                </div>
            </div>
        </div>
        
        <!-- Main Content -->
        <div class="main-content">
            <!-- Left Section - Details -->
            <div class="left-section">
                <h3 class="section-title">PARÂMETROS DA ANÁLISE</h3>
                <div class="data-row">
                    <span class="data-label">VALOR IMÓVEL</span>
                    <span class="data-value">${formatCurrencyUSD(inputs.V0)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">DOWNPAYMENT (${(inputs.dp*100).toFixed(0)}%)</span>
                    <span class="data-value">${formatCurrencyUSD(inputs.V0 * inputs.dp)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">PERÍODO DE ESPERA</span>
                    <span class="data-value">${inputs.m} meses</span>
                </div>
                <div class="data-row">
                    <span class="data-label">QUEDA ESPERADA</span>
                    <span class="data-value">${((inputs.FX0 - inputs.FXbuy) / inputs.FX0 * 100).toFixed(1)}%</span>
                </div>
                <div class="data-row">
                    <span class="data-label">APLICAÇÃO NO BRASIL</span>
                    <span class="data-value">${(inputs.r*100).toFixed(1)}% a.a.</span>
                </div>
                <div class="data-row">
                    <span class="data-label">VALORIZAÇÃO IMÓVEL</span>
                    <span class="data-value">${(inputs.g*100).toFixed(1)}% a.a.</span>
                </div>
                <div class="data-row">
                    <span class="data-label">YIELD/ALUGUEL</span>
                    <span class="data-value">${(inputs.y*100).toFixed(1)}% a.a.</span>
                </div>
            </div>
            
            <!-- Right Section - Metrics -->
            <div class="right-section">
                <div class="metrics-grid">
                    <!-- Ganhos -->
                    <div class="metric-circle">
                        <div class="circle-container">
                            <div class="circle-bg circle-positive">
                                <div class="circle-value">${formatCurrencyBRL(resultado.ganhos.total)}</div>
                                <div class="circle-label">Ganhos</div>
                            </div>
                        </div>
                        <div class="metric-title">TOTAL GANHOS</div>
                    </div>
                    
                    <!-- Perdas -->
                    <div class="metric-circle">
                        <div class="circle-container">
                            <div class="circle-bg circle-negative">
                                <div class="circle-value">${formatCurrencyBRL(resultado.perdas.total)}</div>
                                <div class="circle-label">Perdas</div>
                            </div>
                        </div>
                        <div class="metric-title">TOTAL PERDAS</div>
                    </div>
                </div>
                
                <!-- Capital Details -->
                <div style="text-align: center; margin-top: 30px; padding-top: 30px; border-top: 1px solid #333;">
                    <div style="font-size: 24px; font-weight: 700; color: #e91e63; margin-bottom: 10px;">
                        ${formatCurrencyBRL(resultado.ganhos.aplicacao.base_BRL)}
                    </div>
                    <div style="font-size: 14px; color: #ccc;">CAPITAL APLICADO</div>
                </div>
            </div>
        </div>
        
        <!-- Result Section -->
        <div class="result-section ${resultado.resultado.BRL > 0 ? 'result-positive' : 'result-negative'}">
            <h2 class="result-title">${resultado.resultado.BRL > 0 ? 'VALE A PENA ESPERAR' : 'MELHOR COMPRAR AGORA'}</h2>
            <div class="result-value">${formatCurrencyBRL(Math.abs(resultado.resultado.BRL))}</div>
            <div class="result-value-usd">${formatCurrencyUSD(Math.abs(resultado.resultado.USD))}</div>
            <p class="result-description">
                ${resultado.resultado.BRL > 0 
                    ? `Esperar ${inputs.m} meses resultaria em ganho de ${formatCurrencyBRL(Math.abs(resultado.resultado.BRL))}. A economia no câmbio e os rendimentos compensam a valorização do imóvel.`
                    : `Comprar agora evitaria perda de ${formatCurrencyBRL(Math.abs(resultado.resultado.BRL))}. A valorização do imóvel e os aluguéis perdidos superam a economia esperada no câmbio.`}
            </p>
        </div>
        
        <!-- Detailed Breakdown -->
        <div class="main-content">
            <div class="left-section">
                <h3 class="section-title">GANHOS AO ESPERAR</h3>
                <div class="data-row">
                    <span class="data-label">RENDIMENTO DA APLICAÇÃO</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.ganhos.aplicacao.rendimento_BRL)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">ECONOMIA NO CÂMBIO</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.ganhos.cambio.ganho_BRL)}</span>
                </div>
                <div class="data-row total-row">
                    <span class="data-label">TOTAL GANHOS</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.ganhos.total)}</span>
                </div>
            </div>
            
            <div class="left-section">
                <h3 class="section-title">PERDAS POR ESPERAR</h3>
                <div class="data-row">
                    <span class="data-label">VALORIZAÇÃO IMÓVEL (${formatCurrencyUSD(resultado.perdas.valorizacao.USD)})</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.perdas.valorizacao.BRL)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">YIELD PERDIDO (${formatCurrencyUSD(resultado.perdas.yield.USD)})</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.perdas.yield.BRL)}</span>
                </div>
                <div class="data-row total-row">
                    <span class="data-label">TOTAL PERDAS</span>
                    <span class="data-value">${formatCurrencyBRL(resultado.perdas.total)}</span>
                </div>
            </div>
        </div>
        
        <!-- Footer -->
        <div class="footer">
            <div class="footer-brand">THE FLORIDA LOUNGE</div>
            <div class="footer-info">
                @thefloridalounge | Relatório gerado em ${new Date().toLocaleString('pt-BR')}<br>
                Este relatório é uma simulação educativa e deve ser validada com um especialista.
            </div>
        </div>
    </div>
</body>
</html>
    `;
    
    await page.setContent(html);
    
    // Usa a variável PDF_DIR ao invés do caminho hardcoded
    const timestamp = Date.now();
    const randomHash = crypto.randomBytes(4).toString('hex');
    const nomeArquivo = `analise_cambio_${timestamp}_${randomHash}.pdf`;
    const caminhoCompleto = path.join(PDF_DIR, nomeArquivo);
    
    // Gerar o PDF
    await page.pdf({
      path: caminhoCompleto,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px'
      }
    });
    
    await browser.close();
    
    console.log(`💹 [CAMBIO-PDF] Arquivo PDF criado: ${nomeArquivo} em ${PDF_DIR}`);
    
    // Agendar exclusão do arquivo após 5 minutos
    setTimeout(async () => {
      try {
        await fs.unlink(caminhoCompleto);
        console.log(`💹 [CAMBIO-PDF] PDF ${nomeArquivo} removido após 5 minutos`);
      } catch (error) {
        console.error(`❌ [CAMBIO-PDF] Erro ao remover PDF ${nomeArquivo}:`, error);
      }
    }, 5 * 60 * 1000); // 5 minutos
    
    // URL mantém o formato esperado com subdomínio pdf
    return {
      url: `https://pdf.thebroker.vip:8443/pdf/${nomeArquivo}`,
      validade: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    };
    
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Funções auxiliares para formatar moeda
function formatCurrencyBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

function formatCurrencyUSD(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

// Função de cálculo (incluída aqui para referência, mas pode estar em outro arquivo)
function calcularCustoEsperar(inputs) {
    // Validar e extrair inputs com defaults
    const {
        V0,           // Valor do imóvel em US$ (obrigatório)
        m,            // Meses de espera (obrigatório)
        FX0,          // Câmbio atual (obrigatório)
        FXbuy,        // Câmbio futuro (obrigatório)
        r = 0.12,     // Taxa aplicação anual (default 12%)
        g = 0.05,     // Valorização anual imóvel (default 5%)
        y = 0.08,     // Yield anual imóvel (default 8%)
        dp = 0.30     // Downpayment (default 30%)
    } = inputs;

    // Validar inputs obrigatórios
    if (!V0 || !m || !FX0 || !FXbuy) {
        throw new Error('Inputs obrigatórios: V0, m, FX0, FXbuy');
    }

    // Cálculos intermediários
    const calculos = {};

    // 1. Bases
    calculos.downUS = V0 * dp;
    calculos.Base_Down_BRL = calculos.downUS * FX0;

    // 2. Taxas mensais
    calculos.r_m = Math.pow(1 + r, 1/12) - 1;
    calculos.g_m = Math.pow(1 + g, 1/12) - 1;
    calculos.y_m = Math.pow(1 + y, 1/12) - 1;

    // 3. Ganhos - Aplicação
    calculos.Fator_Rend = Math.pow(1 + calculos.r_m, m);
    calculos.Rend_Down_BRL = calculos.Base_Down_BRL * (calculos.Fator_Rend - 1);

    // 4. Ganhos - Câmbio
    calculos.GanhoFX_Down_BRL = calculos.downUS * (FX0 - FXbuy);

    // 5. Total Ganhos
    calculos.TOTAL_GANHOS = calculos.Rend_Down_BRL + calculos.GanhoFX_Down_BRL;

    // 6. Perdas - Valorização
    calculos.Fator_Val = Math.pow(1 + calculos.g_m, m);
    calculos.ValPerd_USD = V0 * (calculos.Fator_Val - 1);
    calculos.ValPerd_BRL = calculos.ValPerd_USD * FXbuy;

    // 7. Perdas - Yield
    calculos.Fator_Yield = Math.pow(1 + calculos.y_m, m);
    calculos.YieldPerd_USD = V0 * (calculos.Fator_Yield - 1);
    calculos.YieldPerd_BRL = calculos.YieldPerd_USD * FXbuy;

    // 8. Total Perdas
    calculos.TOTAL_PERDAS = calculos.ValPerd_BRL + calculos.YieldPerd_BRL;

    // 9. Resultado Final
    calculos.Resultado_BRL = calculos.TOTAL_GANHOS - calculos.TOTAL_PERDAS;
    calculos.Resultado_USD = calculos.Resultado_BRL / FXbuy;

    // Preparar output formatado
    const output = {
        resultado: {
            BRL: Math.round(calculos.Resultado_BRL),
            USD: Math.round(calculos.Resultado_USD)
        },
        ganhos: {
            total: Math.round(calculos.TOTAL_GANHOS),
            aplicacao: {
                base_BRL: Math.round(calculos.Base_Down_BRL),
                rendimento_BRL: Math.round(calculos.Rend_Down_BRL)
            },
            cambio: {
                ganho_BRL: Math.round(calculos.GanhoFX_Down_BRL)
            }
        },
        perdas: {
            total: Math.round(calculos.TOTAL_PERDAS),
            valorizacao: {
                USD: Math.round(calculos.ValPerd_USD),
                BRL: Math.round(calculos.ValPerd_BRL)
            },
            yield: {
                USD: Math.round(calculos.YieldPerd_USD),
                BRL: Math.round(calculos.YieldPerd_BRL)
            }
        },
        parametros: {
            valor_imovel_USD: V0,
            meses_espera: m,
            cambio_atual: FX0,
            cambio_futuro: FXbuy,
            taxa_aplicacao_anual: r,
            valorizacao_anual: g,
            yield_anual: y,
            downpayment: dp
        },
        calculos_intermediarios: calculos
    };

    return output;
}

async function handleTriggerEsperarJuros(session, message, userInput, sessionName, email) {
  const client   = session.client;
  const sender   = message.from;
  const convoKey = `${session.myNumber}:${sender}`;
  
  // Inicia ou recupera o estado da conversa
  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvesperarjuros'
  };
  
  // Se for a primeira interação, injeta o system prompt
  if (convo.history.length === 0) {
    // Carrega o prompt "EsperarJuros"
    const prompt = loadPrompt('tbvjuros');
    
    // Combina tudo em uma única mensagem system para evitar conflitos
    // MODIFICADO: Removido instruções sobre incluir o link do PDF
    const fullSystemPrompt = `${prompt}

Você tem acesso a uma função chamada calcularEsperarJurosComRefinanciamento que recebe um JSON e retorna os cálculos. 

Quando tiver todos os dados necessários, use esta função passando um objeto JSON com os seguintes campos:
- V0: valor do imóvel em USD (obrigatório)
- m1: meses até a compra (obrigatório)
- m2: meses até entrega após compra (obrigatório, default 1)
- r_atual: taxa de juros atual anual (obrigatório)
- r_futura: taxa de juros futura anual (obrigatório)
- dp: downpayment (opcional, default 0.30)
- g: valorização anual do imóvel (opcional, default 0.05)
- r_app_usd: taxa aplicação em USD (opcional, default 0.04)
- pontos: taxa de pontos (opcional, default 0.015)
- pct_closing: custo refinanciamento (opcional, default 0.01)
- prazo_meses: prazo financiamento (opcional, default 360)

IMPORTANTE: Apresente os resultados de forma clara e profissional, mas NÃO mencione nada sobre PDF ou relatório completo. Apenas forneça a análise detalhada dos números.`;
    
    // Adiciona apenas UMA mensagem system
    convo.history.push({ role: 'system', content: fullSystemPrompt });
    
    // Definir timeout quando conversa inicia
    setConversationTimeout(convoKey, session, sender);
  } else {
    // Renovar timeout a cada interação
    refreshConversationTimeout(convoKey, session, sender);
  }
  
  // Empilha a mensagem do usuário
  convo.history.push({ role: 'user', content: userInput });
  
  // Chama o GPT com capacidade de function calling
  const gptResponse = await openai.chat.completions.create({
    model: ASSISTANT_MODEL,
    messages: convo.history,
    temperature: 0.2,
    functions: [{
      name: "calcularEsperarJurosComRefinanciamento",
      description: "Calcula se vale a pena esperar juros cair ou comprar agora e refinanciar",
      parameters: {
        type: "object",
        properties: {
          V0: { type: "number", description: "Valor do imóvel em USD" },
          m1: { type: "number", description: "Meses até a compra" },
          m2: { type: "number", description: "Meses até entrega após compra" },
          r_atual: { type: "number", description: "Taxa de juros atual anual (ex: 0.08 para 8%)" },
          r_futura: { type: "number", description: "Taxa de juros futura anual (ex: 0.05 para 5%)" },
          dp: { type: "number", description: "Percentual de downpayment (opcional)" },
          g: { type: "number", description: "Valorização anual do imóvel (opcional)" },
          r_app_usd: { type: "number", description: "Taxa aplicação em USD anual (opcional)" },
          pontos: { type: "number", description: "Taxa de pontos (opcional)" },
          pct_closing: { type: "number", description: "Custo refinanciamento (opcional)" },
          prazo_meses: { type: "number", description: "Prazo do financiamento em meses (opcional)" }
        },
        required: ["V0", "m1", "m2", "r_atual", "r_futura"]
      }
    }],
    function_call: "auto"
  });
  
  const responseMessage = gptResponse.choices[0].message;
  
  // Se o GPT chamou a função
  if (responseMessage.function_call) {
    const functionName = responseMessage.function_call.name;
    const functionArgs = JSON.parse(responseMessage.function_call.arguments);
    
    if (functionName === "calcularEsperarJurosComRefinanciamento") {
      let pdfInfo = null;
      
      try {
        // Executa a função de cálculo
        const resultado = calcularEsperarJurosComRefinanciamento(functionArgs);
        
        // Gera o PDF com os resultados
        pdfInfo = await gerarPDFResultado(resultado, functionArgs);
        
        // MODIFICADO: Não incluímos mais o PDF no resultado enviado ao GPT
        convo.history.push({
          role: 'function',
          name: 'calcularEsperarJurosComRefinanciamento',
          content: JSON.stringify(resultado)
        });
        
        // Pede ao GPT para formatar a resposta baseada no resultado
        // MODIFICADO: Adiciona instrução explícita para apenas formatar o JSON
        convo.history.push({
          role: 'system',
          content: `INSTRUÇÃO CRÍTICA:

Você recebeu um JSON com os resultados já calculados. Sua ÚNICA tarefa é apresentar esses valores de forma organizada e clara.

REGRAS OBRIGATÓRIAS:
1. NÃO faça NENHUM cálculo próprio
2. NÃO modifique NENHUM valor recebido
3. NÃO calcule percentuais, diferenças ou qualquer operação matemática
4. NÃO interprete ou valide os números
5. Use APENAS os valores exatos do JSON recebido
6. NÃO mencione PDF ou relatório

Formato EXATO para apresentação:

📊 **ANÁLISE: ESPERAR JUROS vs COMPRAR AGORA**

**Cenário Analisado:**
• Imóvel de US$ [use o valor de parametros.V0]
• Espera de [use parametros.m1] meses para juros caírem
• Taxa atual: [use parametros.r_atual convertido para %]% → Taxa futura: [use parametros.r_futura convertido para %]%

**RESULTADO: [use resultado.conclusao]**
Diferença: US$ [use resultado.valor_final]

✅ **GANHOS AO ESPERAR:**
• Economia pontos refinanciamento: US$ [use ganhos.economia_pontos]
• Economia prestações iniciais: US$ [use ganhos.economia_prestacoes_periodo]
• Rendimento do downpayment: US$ [use ganhos.rendimento_downpayment]
• Total ganhos: US$ [use ganhos.total]

❌ **PERDAS POR ESPERAR:**
• Valorização do imóvel: US$ [use perdas.valorizacao_imovel]
• Downpayment adicional: US$ [use perdas.downpayment_adicional]
• Total perdas: US$ [use perdas.total]

📈 **COMPARAÇÃO DE CENÁRIOS:**

**Se comprar hoje:**
• Downpayment: US$ [use comparacao_cenarios.comprar_hoje.downpayment]
• Prestação inicial ([r_atual]%): US$ [use comparacao_cenarios.comprar_hoje.prestacao_inicial]/mês
• Prestação após refinanciar ([r_futura]%): US$ [use comparacao_cenarios.comprar_hoje.prestacao_apos_refi]/mês

**Se esperar:**
• Downpayment: US$ [use comparacao_cenarios.esperar_comprar.downpayment]
• Prestação única ([r_futura]%): US$ [use comparacao_cenarios.esperar_comprar.prestacao_unica]/mês

💡 **CONCLUSÃO:**
[Se resultado.valor_final > 0]: Esperar [m1] meses resultaria em economia de US$ [valor_final]. Os ganhos com aplicação e economia de juros compensam a valorização do imóvel.
[Se resultado.valor_final < 0]: Comprar agora economizaria US$ [valor_final absoluto]. A valorização do imóvel supera os benefícios de esperar juros menores.

Lembre-se: use APENAS os valores do JSON, sem fazer nenhum cálculo ou modificação.`
        });
        
        const formattedResponse = await openai.chat.completions.create({
          model: ASSISTANT_MODEL,
          messages: convo.history,
          temperature: 0.1  // Temperatura baixa para menor variação
        });
        
        const assistantResponse = formattedResponse.choices[0].message.content.trim();
        convo.history.push({ role: 'assistant', content: assistantResponse });
        
        // Se o GPT devolveu o token de encerramento
        if (assistantResponse === 'finalizando-atendimento') {
          await client.sendText(
            sender,
            '👍 Até mais! Quando quiser fazer uma nova análise, é só digitar o gatilho novamente.'
          );
          clearConversationTimeout(convoKey);
          CONVERSATIONS.delete(convoKey);
          return;
        }
        
        // Envia a resposta do GPT
        await client.sendText(sender, assistantResponse);
        
        // NOVO: Envia o link do PDF manualmente após a resposta do GPT
        if (pdfInfo && pdfInfo.url) {
          const pdfMessage = `📑 **RELATÓRIO COMPLETO EM PDF**

Preparei um relatório detalhado com gráficos e análise visual completa dos seus cenários.

🔗 **Acesse aqui:** ${pdfInfo.url}

⏰ *Link válido até ${new Date(pdfInfo.validade).toLocaleTimeString('pt-BR')} (5 minutos)*

💡 Dica: Salve o PDF para consultas futuras!`;
          
          // Aguarda um pequeno delay para melhor UX
          await new Promise(resolve => setTimeout(resolve, 1500));
          
          // Envia a mensagem com o link do PDF
          await client.sendText(sender, pdfMessage);
        }
        
      } catch (error) {
        console.error('Erro ao processar cálculo ou gerar PDF:', error);
        
        // Se houve erro na geração do PDF, ainda envia a resposta do GPT
        if (!pdfInfo) {
          await client.sendText(
            sender,
            '⚠️ Não consegui gerar o PDF com o relatório visual, mas a análise acima está completa com todos os dados necessários para sua decisão.'
          );
        }
      }
    }
  } else {
    // Resposta normal sem chamar função
    const assistantResponse = responseMessage.content.trim();
    convo.history.push({ role: 'assistant', content: assistantResponse });
    
    // Se o GPT devolveu o token de encerramento
    if (assistantResponse === 'finalizando-atendimento') {
      await client.sendText(
        sender,
        '👍 Até mais! Quando quiser fazer uma nova análise, é só digitar o gatilho novamente.'
      );
      clearConversationTimeout(convoKey);
      CONVERSATIONS.delete(convoKey);
      return;
    }
    
    await client.sendText(sender, assistantResponse);
  }
  
  // Salva o estado da conversa
  CONVERSATIONS.set(convoKey, convo);
}

// Função para gerar o PDF (mantida sem alterações)
async function gerarPDFResultado(resultado, inputs) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    // HTML com design profissional inspirado no PDF
    const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', Arial, sans-serif;
            background-color: #1a1a1a;
            color: #ffffff;
            line-height: 1.6;
        }
        
        .page {
            max-width: 1200px;
            margin: 0 auto;
            background-color: #ffffff;
            min-height: 100vh;
        }
        
        /* Header */
        .header {
            background-color: #000000;
            color: #ffffff;
            padding: 30px 40px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .header h1 {
            font-size: 32px;
            font-weight: 700;
            letter-spacing: -1px;
        }
        
        .logo {
            font-size: 18px;
            font-weight: 600;
            text-align: right;
        }
        
        /* Subtitle Bar */
        .subtitle-bar {
            background-color: #e91e63;
            color: #ffffff;
            padding: 10px 40px;
            font-size: 14px;
            font-weight: 600;
        }
        
        /* Main Content */
        .main-content {
            display: grid;
            grid-template-columns: 1fr 2fr;
            gap: 30px;
            padding: 30px 40px;
            background-color: #f5f5f5;
        }
        
        /* Left Section */
        .left-section {
            background-color: #ffffff;
            padding: 25px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        
        .section-title {
            background-color: #e91e63;
            color: #ffffff;
            padding: 10px 15px;
            margin: -25px -25px 20px -25px;
            font-size: 16px;
            font-weight: 600;
            border-radius: 8px 8px 0 0;
        }
        
        .data-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #f0f0f0;
        }
        
        .data-row:last-child {
            border-bottom: none;
        }
        
        .data-label {
            font-size: 13px;
            color: #666;
        }
        
        .data-value {
            font-size: 14px;
            font-weight: 600;
            color: #333;
        }
        
        .total-row {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 2px solid #e91e63;
        }
        
        .total-row .data-label {
            font-weight: 700;
            color: #333;
        }
        
        .total-row .data-value {
            font-size: 16px;
            color: #e91e63;
        }
        
        /* Right Section - Metrics */
        .right-section {
            background-color: #000000;
            padding: 30px;
            border-radius: 8px;
            color: #ffffff;
        }
        
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 25px;
            margin-bottom: 30px;
        }
        
        .metric-circle {
            text-align: center;
        }
        
        .circle-container {
            width: 120px;
            height: 120px;
            margin: 0 auto 10px;
            position: relative;
        }
        
        .circle-bg {
            width: 100%;
            height: 100%;
            border-radius: 50%;
            border: 8px solid #333;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-direction: column;
        }
        
        .circle-positive {
            border-color: #4caf50;
        }
        
        .circle-negative {
            border-color: #e91e63;
        }
        
        .circle-value {
            font-size: 24px;
            font-weight: 700;
        }
        
        .circle-label {
            font-size: 12px;
            color: #ccc;
            margin-top: 5px;
        }
        
        .metric-title {
            font-size: 14px;
            color: #ccc;
            font-weight: 600;
        }
        
        /* Bottom Metrics */
        .bottom-metrics {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 30px;
            margin-top: 30px;
            padding-top: 30px;
            border-top: 1px solid #333;
        }
        
        .big-metric {
            text-align: center;
            padding: 20px;
            border: 2px solid #333;
            border-radius: 8px;
        }
        
        .big-metric-value {
            font-size: 32px;
            font-weight: 700;
            color: #e91e63;
            margin-bottom: 5px;
        }
        
        .big-metric-label {
            font-size: 14px;
            color: #ccc;
        }
        
        /* Result Section */
        .result-section {
            background-color: #ffffff;
            margin: 0 40px 30px;
            padding: 25px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            text-align: center;
        }
        
        .result-positive {
            border: 3px solid #4caf50;
        }
        
        .result-negative {
            border: 3px solid #e91e63;
        }
        
        .result-title {
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 10px;
            color: #333;
        }
        
        .result-value {
            font-size: 36px;
            font-weight: 700;
            margin-bottom: 15px;
        }
        
        .result-positive .result-value {
            color: #4caf50;
        }
        
        .result-negative .result-value {
            color: #e91e63;
        }
        
        .result-description {
            font-size: 14px;
            color: #666;
            line-height: 1.6;
        }
        
        /* Footer */
        .footer {
            background-color: #000;
            color: #ffffff;
            padding: 30px 40px;
            text-align: center;
        }
        
        .footer-brand {
            font-size: 18px;
            font-weight: 700;
            margin-bottom: 10px;
        }
        
        .footer-info {
            font-size: 12px;
            color: #ccc;
        }
        
        /* Responsiveness for PDF */
        @media print {
            body {
                background-color: #ffffff;
            }
            .page {
                max-width: 100%;
            }
        }
    </style>
</head>
<body>
    <div class="page">
        <!-- Header -->
        <div class="header">
            <h1>ANÁLISE ESPERAR JUROS CAIR</h1>
            <div class="logo">THE FLORIDA<br>LOUNGE</div>
        </div>
        
        <!-- Subtitle -->
        <div class="subtitle-bar">
            IMÓVEL: ${formatCurrency(inputs.V0)} | ESPERA: ${inputs.m1} MESES | JUROS: ${(inputs.r_atual*100).toFixed(1)}% → ${(inputs.r_futura*100).toFixed(1)}%
        </div>
        
        <!-- Main Content -->
        <div class="main-content">
            <!-- Left Section - Details -->
            <div class="left-section">
                <h3 class="section-title">CENÁRIO ATUAL</h3>
                <div class="data-row">
                    <span class="data-label">VALOR IMÓVEL</span>
                    <span class="data-value">${formatCurrency(inputs.V0)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">DOWNPAYMENT (${((inputs.dp || 0.30)*100).toFixed(0)}%)</span>
                    <span class="data-value">${formatCurrency(resultado.comparacao_cenarios.comprar_hoje.downpayment)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">VALOR FINANCIADO</span>
                    <span class="data-value">${formatCurrency(resultado.comparacao_cenarios.comprar_hoje.valor_financiado)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">TAXA ATUAL</span>
                    <span class="data-value">${(inputs.r_atual*100).toFixed(1)}%</span>
                </div>
                <div class="data-row">
                    <span class="data-label">PRESTAÇÃO INICIAL</span>
                    <span class="data-value">${formatCurrency(resultado.comparacao_cenarios.comprar_hoje.prestacao_inicial)}</span>
                </div>
            </div>
            
            <!-- Right Section - Metrics -->
            <div class="right-section">
                <div class="metrics-grid">
                    <!-- Ganhos -->
                    <div class="metric-circle">
                        <div class="circle-container">
                            <div class="circle-bg circle-positive">
                                <div class="circle-value">${formatCurrency(resultado.ganhos.total)}</div>
                                <div class="circle-label">Ganhos</div>
                            </div>
                        </div>
                        <div class="metric-title">TOTAL GANHOS</div>
                    </div>
                    
                    <!-- Perdas -->
                    <div class="metric-circle">
                        <div class="circle-container">
                            <div class="circle-bg circle-negative">
                                <div class="circle-value">${formatCurrency(resultado.perdas.total)}</div>
                                <div class="circle-label">Perdas</div>
                            </div>
                        </div>
                        <div class="metric-title">TOTAL PERDAS</div>
                    </div>
                    
                    <!-- Valorização -->
                    <div class="metric-circle">
                        <div class="circle-container">
                            <div class="circle-bg">
                                <div class="circle-value">${((inputs.g || 0.05)*100).toFixed(0)}%</div>
                                <div class="circle-label">a.a.</div>
                            </div>
                        </div>
                        <div class="metric-title">VALORIZAÇÃO</div>
                    </div>
                </div>
                
                <!-- Bottom Metrics -->
                <div class="bottom-metrics">
                    <div class="big-metric">
                        <div class="big-metric-value">${formatCurrency(resultado.comparacao_cenarios.comprar_hoje.prestacao_inicial)}</div>
                        <div class="big-metric-label">Prestação<br>Taxa Alta</div>
                    </div>
                    <div class="big-metric">
                        <div class="big-metric-value">${formatCurrency(resultado.comparacao_cenarios.esperar_comprar.prestacao_unica)}</div>
                        <div class="big-metric-label">Prestação<br>Se Esperar</div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Result Section -->
        <div class="result-section ${resultado.resultado.valor_final > 0 ? 'result-positive' : 'result-negative'}">
            <h2 class="result-title">${resultado.resultado.conclusao.toUpperCase()}</h2>
            <div class="result-value">${formatCurrency(Math.abs(resultado.resultado.valor_final))}</div>
            <p class="result-description">
                ${resultado.resultado.valor_final > 0 
                    ? `Esperar ${inputs.m1} meses resultaria em uma economia de ${formatCurrency(Math.abs(resultado.resultado.valor_final))}. Os ganhos com aplicação do capital e economia de pontos compensam a valorização do imóvel.`
                    : `Comprar agora economizaria ${formatCurrency(Math.abs(resultado.resultado.valor_final))}. A valorização do imóvel em ${inputs.m1} meses supera os benefícios de esperar juros menores.`}
            </p>
        </div>
        
        <!-- Detailed Breakdown -->
        <div class="main-content">
            <div class="left-section">
                <h3 class="section-title">GANHOS AO ESPERAR</h3>
                <div class="data-row">
                    <span class="data-label">ECONOMIA PONTOS</span>
                    <span class="data-value">${formatCurrency(resultado.ganhos.economia_pontos)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">ECONOMIA PRESTAÇÕES</span>
                    <span class="data-value">${formatCurrency(resultado.ganhos.economia_prestacoes_periodo || 0)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">RENDIMENTO DOWNPAYMENT</span>
                    <span class="data-value">${formatCurrency(resultado.ganhos.rendimento_downpayment)}</span>
                </div>
                <div class="data-row total-row">
                    <span class="data-label">TOTAL GANHOS</span>
                    <span class="data-value">${formatCurrency(resultado.ganhos.total)}</span>
                </div>
            </div>
            
            <div class="left-section">
                <h3 class="section-title">PERDAS POR ESPERAR</h3>
                <div class="data-row">
                    <span class="data-label">VALORIZAÇÃO IMÓVEL</span>
                    <span class="data-value">${formatCurrency(resultado.perdas.valorizacao_imovel)}</span>
                </div>
                <div class="data-row">
                    <span class="data-label">DOWNPAYMENT ADICIONAL</span>
                    <span class="data-value">${formatCurrency(resultado.perdas.downpayment_adicional)}</span>
                </div>
                <div class="data-row total-row">
                    <span class="data-label">TOTAL PERDAS</span>
                    <span class="data-value">${formatCurrency(resultado.perdas.total)}</span>
                </div>
            </div>
        </div>
        
        <!-- Footer -->
        <div class="footer">
            <div class="footer-brand">THE FLORIDA LOUNGE</div>
            <div class="footer-info">
                @thefloridalounge | Relatório gerado em ${new Date().toLocaleString('pt-BR')}<br>
                Este relatório é uma simulação educativa e deve ser validada com um especialista.
            </div>
        </div>
    </div>
</body>
</html>
    `;
    
    await page.setContent(html);
    
    // Usa a variável PDF_DIR ao invés do caminho hardcoded
    const timestamp = Date.now();
    const randomHash = crypto.randomBytes(4).toString('hex');
    const nomeArquivo = `analise_juros_${timestamp}_${randomHash}.pdf`;
    const caminhoCompleto = path.join(PDF_DIR, nomeArquivo);
    
    // Gerar o PDF
    await page.pdf({
      path: caminhoCompleto,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px'
      }
    });
    
    await browser.close();
    
    console.log(`📊 [JUROS-PDF] Arquivo PDF criado: ${nomeArquivo} em ${PDF_DIR}`);
    
    // Agendar exclusão do arquivo após 5 minutos
    setTimeout(async () => {
      try {
        await fs.unlink(caminhoCompleto);
        console.log(`📊 [JUROS-PDF] PDF ${nomeArquivo} removido após 5 minutos`);
      } catch (error) {
        console.error(`❌ [JUROS-PDF] Erro ao remover PDF ${nomeArquivo}:`, error);
      }
    }, 5 * 60 * 1000); // 5 minutos
    
    // URL mantém o formato esperado com subdomínio pdf
    return {
      url: `https://pdf.thebroker.vip:8443/pdf/${nomeArquivo}`,
      validade: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    };
    
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Função auxiliar para formatar moeda
function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

// Função de cálculo (mesma que criamos anteriormente)
function calcularEsperarJurosComRefinanciamento(inputs) {
    // Validar e extrair inputs com defaults
    const {
        V0,                    // Valor do imóvel em US$ (obrigatório)
        m1,                    // Meses até a compra (obrigatório)
        m2 = 1,               // Meses até entrega após compra (default 1)
        r_atual,              // Taxa de juros atual anual (obrigatório)
        r_futura,             // Taxa de juros futura anual (obrigatório)
        dp = 0.30,            // Downpayment (default 30%)
        g = 0.05,             // Valorização anual imóvel (default 5%)
        r_app_usd = 0.04,     // Taxa aplicação em USD (default 4% a.a.)
        pontos = 0.015,       // Taxa de pontos (default 1.5%)
        prazo_meses = 360,    // Prazo financiamento (default 30 anos)
        pct_closing = 0.01    // Custo refinanciamento (default 1%)
    } = inputs;

    // Validar inputs obrigatórios
    if (!V0 || !m1 || r_atual === undefined || r_futura === undefined) {
        throw new Error('Inputs obrigatórios: V0, m1, r_atual, r_futura');
    }

    // Função auxiliar PMT (pagamento mensal)
    function PMT(rate, nper, pv) {
        if (rate === 0) return -pv / nper;
        const pvif = Math.pow(1 + rate, nper);
        const pmt = rate * pv * pvif / (pvif - 1);
        return pmt;
    }

    // Cálculos
    const calculos = {};
    
    // Período total de espera
    const periodo_total = m1 + m2;

    // 1. Valorização do imóvel durante a espera
    const g_m = Math.pow(1 + g, 1/12) - 1;
    calculos.Val_Perdida = V0 * (Math.pow(1 + g_m, m1) - 1);
    calculos.V0_Valorizado = V0 + calculos.Val_Perdida;

    // 2. Valores de downpayment
    calculos.Down_Inicial = V0 * dp;
    calculos.Down_Futuro = calculos.V0_Valorizado * dp;

    // 3. Valores financiados
    calculos.Financiado_Inicial = V0 * (1 - dp);
    calculos.Financiado_Futuro = calculos.V0_Valorizado * (1 - dp);
    
    // Prestações
    const r_mensal_atual = r_atual / 12;
    const r_mensal_futura = r_futura / 12;
    
    calculos.Prestacao_Alta = PMT(r_mensal_atual, prazo_meses, calculos.Financiado_Inicial);
    calculos.Prestacao_Futura = PMT(r_mensal_futura, prazo_meses, calculos.Financiado_Futuro);
    
    // Saldo após período para refinanciamento
    let saldo_apos_periodo = calculos.Financiado_Inicial;
    for (let i = 0; i < periodo_total; i++) {
        const juros_mes = saldo_apos_periodo * r_mensal_atual;
        const amortizacao = calculos.Prestacao_Alta - juros_mes;
        saldo_apos_periodo -= amortizacao;
    }
    
    // Refinanciamento
    calculos.Closing_Cost_Refi = V0 * pct_closing;
    calculos.Valor_Refinanciamento = saldo_apos_periodo + calculos.Closing_Cost_Refi;
    
    const meses_restantes = prazo_meses - periodo_total;
    calculos.Prestacao_Refinanciada = PMT(r_mensal_futura, meses_restantes, calculos.Valor_Refinanciamento);
    
    // GANHOS
    calculos.Economia_Pontos = calculos.Financiado_Inicial * pontos;
    calculos.Economia_Prestacoes_Periodo = (calculos.Prestacao_Alta - calculos.Prestacao_Futura) * periodo_total;
    
    const r_app_mensal = Math.pow(1 + r_app_usd, 1/12) - 1;
    calculos.Rendimento_Down = calculos.Down_Inicial * (Math.pow(1 + r_app_mensal, m1) - 1);
    
    calculos.TOTAL_GANHOS = calculos.Economia_Pontos + calculos.Economia_Prestacoes_Periodo + calculos.Rendimento_Down;
    
    // PERDAS
    calculos.Perda_Valorizacao = calculos.Val_Perdida;
    calculos.Perda_Down = calculos.Down_Futuro - calculos.Down_Inicial;
    
    calculos.TOTAL_PERDAS = calculos.Perda_Valorizacao + calculos.Perda_Down;
    
    // Resultado
    calculos.Resultado = calculos.TOTAL_GANHOS - calculos.TOTAL_PERDAS;

    // Preparar output
    const output = {
        resultado: {
            valor_final: Math.round(calculos.Resultado),
            conclusao: calculos.Resultado > 0 ? "Vale a pena esperar" : "Melhor comprar agora"
        },
        ganhos: {
            economia_pontos: Math.round(calculos.Economia_Pontos),
            economia_prestacoes_periodo: Math.round(calculos.Economia_Prestacoes_Periodo),
            rendimento_downpayment: Math.round(calculos.Rendimento_Down),
            total: Math.round(calculos.TOTAL_GANHOS)
        },
        perdas: {
            valorizacao_imovel: Math.round(calculos.Perda_Valorizacao),
            downpayment_adicional: Math.round(calculos.Perda_Down),
            total: Math.round(calculos.TOTAL_PERDAS)
        },
        comparacao_cenarios: {
            comprar_hoje: {
                downpayment: Math.round(calculos.Down_Inicial),
                valor_financiado: Math.round(calculos.Financiado_Inicial),
                prestacao_inicial: Math.round(calculos.Prestacao_Alta),
                custo_refinanciamento: Math.round(calculos.Closing_Cost_Refi),
                prestacao_apos_refi: Math.round(calculos.Prestacao_Refinanciada)
            },
            esperar_comprar: {
                downpayment: Math.round(calculos.Down_Futuro),
                valor_financiado: Math.round(calculos.Financiado_Futuro),
                prestacao_unica: Math.round(calculos.Prestacao_Futura)
            }
        },
        parametros: inputs,
        detalhes: {
            valor_imovel_valorizado: Math.round(calculos.V0_Valorizado),
            periodo_total_espera: periodo_total,
            saldo_ao_refinanciar: Math.round(saldo_apos_periodo)
        }
    };

    return output;
}

async function handleTriggerTBVConstruction(session, message, userInput, sessionName, email) {
  const client = session.client;
  const sender = message.from;
  const convoKey = `${session.myNumber}:${sender}`;

  // Obtemos (ou iniciamos) a sessão de conversa
  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvconstruction'
  };

  // Carrega o prompt "TBVConstruction" com as Instruções Revisadas
  const prompt = loadPrompt('TBVConstruction');

  // Na primeira vez, injetamos o sistema
  if (convo.history.length === 0) {
    convo.history.push({ role: 'system', content: prompt });
    // ✅ NOVO: Definir timeout quando conversa inicia
    setConversationTimeout(convoKey, session, sender);
  } else {
    // ✅ NOVO: Renovar timeout a cada interação
    refreshConversationTimeout(convoKey, session, sender);
  }

  // Empilha a mensagem do usuário
  convo.history.push({ role: 'user', content: userInput });

  // Chama o GPT
  const gptResponse = await openai.chat.completions.create({
    model: ASSISTANT_MODEL,
    messages: convo.history,
    temperature: 0.2
  });

  let assistantResponse = gptResponse.choices[0].message.content.trim();
  convo.history.push({ role: 'assistant', content: assistantResponse });

  // Envia a resposta intermediária ao usuário
  await client.sendText(sender, assistantResponse);

  // Se o GPT já incluiu a pergunta de fechamento, apenas salvamos o estado e aguardamos resposta
  const esperaMaisInfo = /deseja.*(mais).*informação\?/i.test(assistantResponse);
  if (esperaMaisInfo) {
    CONVERSATIONS.set(convoKey, convo);
    return;
  }

  // Se o usuário respondeu "não" depois da pergunta de fechamento, encerramos
  if (/^(não|nao)\b/i.test(userInput) && convo.activeTrigger === 'tbvconstruction') {
    await client.sendText(sender, '👍 Entendido! Encerrando este atendimento. Se precisar, é só chamar outro serviço.');
    // ✅ NOVO: Limpar timeout quando conversa termina
    clearConversationTimeout(convoKey);
    CONVERSATIONS.delete(convoKey);
    return;
  }

  // Senão, continuamos o fluxo normalmente
  CONVERSATIONS.set(convoKey, convo);
}


async function handleTriggerTBVRentabilidade(session, message, userInput, sessionName, email) {
  const client   = session.client;
  const sender   = message.from;
  const convoKey = `${session.myNumber}:${sender}`;

  // Inicia ou recupera o estado da conversa
  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvrentabilidade'
  };

  // Carrega o prompt "TBVRentabilidade" (arquivo prompts/TBVRentabilidade.txt)
  const prompt = loadPrompt('TBVRentabilidade');

  // Se for a primeira interação, injeta o system prompt
  if (convo.history.length === 0) {
    convo.history.push({ role: 'system', content: prompt });
    // ✅ NOVO: Definir timeout quando conversa inicia
    setConversationTimeout(convoKey, session, sender);
  } else {
    // ✅ NOVO: Renovar timeout a cada interação
    refreshConversationTimeout(convoKey, session, sender);
  }

  // Empilha a mensagem do usuário
  convo.history.push({ role: 'user', content: userInput });

  // Chama o GPT
  const gptResponse = await openai.chat.completions.create({
    model:       ASSISTANT_MODEL,
    messages:    convo.history,
    temperature: 0.2
  });

  const assistantResponse = gptResponse.choices[0].message.content.trim();
  convo.history.push({ role: 'assistant', content: assistantResponse });

  // Se o GPT devolveu o token de encerramento, finaliza aqui:
  if (assistantResponse === 'finalizando-atendimento') {
    await client.sendText(
      sender,
      '👍 Até mais! Quando quiser retomar a análise de rentabilidade, é só digitar o gatilho novamente.'
    );
    // ✅ NOVO: Limpar timeout quando conversa termina automaticamente
    clearConversationTimeout(convoKey);
    CONVERSATIONS.delete(convoKey);
    return;
  }

  // Caso contrário, envia a resposta normal e mantém o estado
  await client.sendText(sender, assistantResponse);
  CONVERSATIONS.set(convoKey, convo);
}


async function handleTriggerMortgage(session, message, userInput, sessionName, email) {
  const client   = session.client;
  const sender   = message.from;
  const convoKey = `${session.myNumber}:${sender}`;

  // Inicia ou recupera o estado da conversa
  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvmortgage'
  };

  // Carrega o prompt "TBVMortgage" (arquivo prompts/TBVMortgage.txt)
  const prompt = loadPrompt('TBVMortgage');

  // Se for a primeira interação, injeta o system prompt
  if (convo.history.length === 0) {
    convo.history.push({ role: 'system', content: prompt });
    // ✅ NOVO: Definir timeout quando conversa inicia
    setConversationTimeout(convoKey, session, sender);
  } else {
    // ✅ NOVO: Renovar timeout a cada interação
    refreshConversationTimeout(convoKey, session, sender);
  }

  // Empilha a mensagem do usuário
  convo.history.push({ role: 'user', content: userInput });

  // Chama o GPT
  const gptResponse = await openai.chat.completions.create({
    model:      ASSISTANT_MODEL,
    messages:   convo.history,
    temperature: 0.2
  });

  const assistantResponse = gptResponse.choices[0].message.content.trim();
  convo.history.push({ role: 'assistant', content: assistantResponse });

  // Se o GPT devolveu o token de encerramento, finaliza aqui:
  if (assistantResponse === 'finalizando-atendimento') {
    await client.sendText(
      sender,
      '👍 Até mais! Quando quiser retomar o financiamento, é só digitar o gatilho novamente.'
    );
    // ✅ NOVO: Limpar timeout quando conversa termina automaticamente
    clearConversationTimeout(convoKey);
    CONVERSATIONS.delete(convoKey);
    return;
  }

  // Caso contrário, envia a resposta normal e mantém o estado
  await client.sendText(sender, assistantResponse);
  CONVERSATIONS.set(convoKey, convo);
}



async function handleTriggervalidation(session, message, userInput, sessionName, email) {
  const client = session.client;
  const sender = message.from;
  const convoKey = `${session.myNumber}:${sender}`;

  // Inicia ou recupera o estado da conversa
  let convo = CONVERSATIONS.get(convoKey) || {
    history: [],
    activeTrigger: 'tbvvalidation'
  };

  // Carrega o prompt "tbvvalidation"
  const prompt = loadPrompt('tbvantimalandro');

  // Se for a primeira interação, injeta o system prompt
  if (convo.history.length === 0) {
    convo.history.push({ role: 'system', content: prompt });
    setConversationTimeout(convoKey, session, sender);
  } else {
    refreshConversationTimeout(convoKey, session, sender);
  }

  // Empilha a mensagem do usuário
  convo.history.push({ role: 'user', content: userInput });

  // Chama o GPT
  const gptResponse = await openai.chat.completions.create({
    model: ASSISTANT_MODEL,
    messages: convo.history,
    temperature: 0.2
  });

  const assistantResponse = gptResponse.choices[0].message.content.trim();
  convo.history.push({ role: 'assistant', content: assistantResponse });

  // Se o GPT devolveu o token de encerramento, finaliza
  if (assistantResponse === 'finalizando-atendimento') {
    await client.sendText(
      sender,
      '👍 Até mais! Quando precisar de análise de documentos, é só digitar o gatilho novamente.'
    );
    clearConversationTimeout(convoKey);
    CONVERSATIONS.delete(convoKey);
    return;
  }

  // Caso contrário, envia a resposta normal e mantém o estado
  await client.sendText(sender, assistantResponse);

  // Se a resposta indica que está esperando PDF, adicionar instrução específica
  if (assistantResponse.toLowerCase().includes('pdf') || 
      assistantResponse.toLowerCase().includes('documento') ||
      assistantResponse.toLowerCase().includes('envie')) {
    
    setTimeout(async () => {
      await client.sendText(sender, 
        '📎 *Importante:* Envie apenas arquivos PDF. Outros formatos não serão processados.\n' +
        'O documento será analisado automaticamente quando recebido.'
      );
    }, 1000);
  }

  CONVERSATIONS.set(convoKey, convo);
}

// Mapeamento de triggers e suas funções
const TRIGGERS = {
  tbvevents: handleTBVEventosConversation,
  tbvconstruction: handleTriggerTBVConstruction,
  tbvrentabilidade: handleTriggerTBVRentabilidade,
  tbvmortgage: handleTriggerMortgage,
  tbvvalidation : handleTriggervalidation,
  tbvbusinesscard : handleTriggerBusinessCard,
  tbvesperardolar: handleTriggerEsperarDolar,
  tbvesperarjuros: handleTriggerEsperarJuros
};

// =======================================================================================================================================================

async function checkTriggerInAudio(buffer, sessionName, messageId, message) {
  const formData = new FormData();
  const tempFile = path.join(AUDIO_DIR, `temp_trigger_${sessionName}_${messageId}.ogg`);
  fs.writeFileSync(tempFile, buffer);
  formData.append('file', fs.createReadStream(tempFile));
  formData.append('model', 'whisper-1');

  try {
    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: {
        ...formData.getHeaders(),
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      }
    });

    // CORREÇÃO: Validar o transcript primeiro
    let transcript = response.data.text;
    
    // Garantir que transcript seja uma string válida
    if (!transcript || typeof transcript !== 'string') {
      console.error('❌ Transcript inválido da API Whisper:', transcript);
      try { fs.unlinkSync(tempFile); } catch (err) {}
      return { trigger: 'nenhum', transcript: '' };
    }

    // Limpar o transcript de caracteres problemáticos
    transcript = transcript.trim();

    // Verifica se a mensagem não foi enviada ao número do bot
    if (message.to !== MAIN_BOT_NUMBER) {
      try { fs.unlinkSync(tempFile); } catch (err) {}
      return { trigger: 'nenhum', transcript };
    }

    // CORREÇÃO: Validar rawPrompt antes de usar
    const rawPrompt = loadPrompt('TBV-Router');
    
    if (!rawPrompt || typeof rawPrompt !== 'string') {
      console.error('❌ RawPrompt inválido:', rawPrompt);
      try { fs.unlinkSync(tempFile); } catch (err) {}
      return { trigger: 'nenhum', transcript };
    }
    
    // CORREÇÃO: Construir checkPrompt com validação e garantir que seja string
    const checkPrompt = `${rawPrompt}\n\nMensagem:\n"""${transcript}"""`;
    
    // Validar se checkPrompt é uma string válida
    if (typeof checkPrompt !== 'string' || checkPrompt.length === 0) {
      console.error('❌ CheckPrompt inválido:', typeof checkPrompt, checkPrompt?.length);
      try { fs.unlinkSync(tempFile); } catch (err) {}
      return { trigger: 'nenhum', transcript };
    }
    
    // CORREÇÃO: Garantir que checkPrompt seja string pura
    const cleanCheckPrompt = String(checkPrompt);

    const requestPayload = {
      model: 'gpt-4.1', // Mantendo o modelo original conforme especificado
      messages: [
        { 
          role: 'system', 
          content: String('Você é um classificador de intenções baseado em texto.') 
        },
        { 
          role: 'user', 
          content: cleanCheckPrompt
        }
      ],
      temperature: 0.2,
      max_tokens: 100
    };

    const result = await axios.post('https://api.openai.com/v1/chat/completions', requestPayload, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    try {
      fs.unlinkSync(tempFile);
    } catch (err) {
      console.warn(`⚠️ Arquivo já deletado ou inexistente: ${tempFile}`);
    }

    const trigger = result.data.choices[0].message.content.trim().toLowerCase();
    return { trigger, transcript };
    
  } catch (apiError) {
    console.error('❌ Erro na API OpenAI:', apiError?.response?.data || apiError.message);
    try { fs.unlinkSync(tempFile); } catch (err) {}
    return { trigger: 'nenhum', transcript: '' };
  }
}

async function processPdfDocument(sessionName, message, email) {
  console.log(`📄 [PDF-PROCESSOR] Iniciando processamento de PDF para sessão ${sessionName}`);
  console.log(`📄 [PDF-PROCESSOR] Arquivo: ${message.filename}`);
  console.log(`📄 [PDF-PROCESSOR] Sender: ${message.from}`);
  
  try {
    if (!SESSIONS.has(sessionName)) throw new Error(`Sessão ${sessionName} não encontrada.`);

    const session = SESSIONS.get(sessionName);
    const client = session.client;
    const sender = message.from;
    const convoKey = `${session.myNumber}:${sender}`;
    const stored = CONVERSATIONS.get(convoKey);

    console.log(`📄 [PDF-PROCESSOR] ConvoKey: ${convoKey}`);
    console.log(`📄 [PDF-PROCESSOR] Stored conversation:`, stored ? `Active trigger: ${stored.activeTrigger}` : 'null');

    // Verificar se há uma conversa ativa do tbvvalidation esperando PDF
    if (!stored || stored.activeTrigger !== 'tbvvalidation') {
      console.log('📄 [PDF-PROCESSOR] ❌ PDF recebido, mas não há conversa ativa do tbvvalidation');
      return;
    }

    // Verificar se é um arquivo PDF
    if (!message.filename || !message.filename.toLowerCase().endsWith('.pdf')) {
      console.log(`📄 [PDF-PROCESSOR] ❌ Arquivo inválido: ${message.filename}`);
      await client.sendText(sender, '⚠️ Por favor, envie apenas arquivos PDF.');
      return;
    }

    console.log(`📄 [PDF-PROCESSOR] ✅ Validações passaram. Iniciando processamento...`);

    // Enviar mensagem de processamento
    await client.sendText(sender, '📄 Analisando seu PDF... Por favor, aguarde alguns instantes.');

    // Renovar timeout da conversa
    refreshConversationTimeout(convoKey, session, sender);

    // Baixar o arquivo PDF
    console.log(`📄 [PDF-PROCESSOR] 🔽 Baixando arquivo PDF...`);
    let buffer = await client.decryptFile(message);
    console.log(`📄 [PDF-PROCESSOR] ✅ Buffer baixado. Tamanho: ${buffer.length} bytes`);
    
    // Salvar arquivo temporário para upload
    const tempFilePath = path.join(AUDIO_DIR, `temp_pdf_${sessionName}_${message.id}.pdf`);
    console.log(`📄 [PDF-PROCESSOR] 💾 Salvando arquivo temporário: ${tempFilePath}`);
    
    try {
      fs.writeFileSync(tempFilePath, buffer);
      console.log(`📄 [PDF-PROCESSOR] ✅ Arquivo salvo temporariamente com sucesso`);
      
      // Verificar se o arquivo foi criado corretamente
      const stats = fs.statSync(tempFilePath);
      console.log(`📄 [PDF-PROCESSOR] 📊 Tamanho do arquivo salvo: ${stats.size} bytes`);
      
      // 1. Upload do PDF para OpenAI Files API
      console.log(`📄 [PDF-PROCESSOR] 📤 Iniciando upload para OpenAI Files API...`);
      
      const formData = new FormData();
      formData.append('file', fs.createReadStream(tempFilePath));
      formData.append('purpose', 'user_data');

      console.log(`📄 [PDF-PROCESSOR] 🔄 Enviando request para OpenAI Files API...`);
      const uploadStartTime = Date.now();
      
      const uploadResponse = await axios.post('https://api.openai.com/v1/files', formData, {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        timeout: 60000 // 60 segundos de timeout
      });

      const uploadDuration = Date.now() - uploadStartTime;
      const fileId = uploadResponse.data.id;
      
      console.log(`📄 [PDF-PROCESSOR] ✅ Upload concluído em ${uploadDuration}ms`);
      console.log(`📄 [PDF-PROCESSOR] 🆔 File ID: ${fileId}`);
      console.log(`📄 [PDF-PROCESSOR] 📋 Response status: ${uploadResponse.status}`);
      console.log(`📄 [PDF-PROCESSOR] 📋 Response data:`, JSON.stringify(uploadResponse.data, null, 2));

      // Verificar se o arquivo foi processado pela OpenAI
      console.log(`📄 [PDF-PROCESSOR] 🔍 Verificando status do arquivo...`);
      try {
        const fileStatusResponse = await axios.get(`https://api.openai.com/v1/files/${fileId}`, {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          }
        });
        console.log(`📄 [PDF-PROCESSOR] 📊 Status do arquivo:`, JSON.stringify(fileStatusResponse.data, null, 2));
      } catch (statusError) {
        console.warn(`📄 [PDF-PROCESSOR] ⚠️ Erro ao verificar status do arquivo:`, statusError.message);
      }

      // Recuperar a conversa ativa
      let convo = CONVERSATIONS.get(convoKey);
      if (!convo) {
        console.error('📄 [PDF-PROCESSOR] ❌ Conversa não encontrada para processar PDF');
        return;
      }

      // 2. Criar request para a nova API responses
      console.log(`📄 [PDF-PROCESSOR] 🤖 Preparando request para análise com GPT...`);
      
      const contractAnalysisPrompt = `Você é um Analista de Contratos Imobiliários da Flórida especializado no contrato "AS IS Residential Contract for Sale and Purchase" aprovado pela Florida Realtors e Florida Bar Association. Sua função é proteger usuários contra fraudes, analisando contratos enviados e comparando-os com a versão padrão oficial.

Processo de Análise (Obrigatório)

Etapa 1: Sumário da Oferta

Extraia e apresente um sumário organizado incluindo:

• Partes: Vendedor e Comprador
• Propriedade: Endereço completo e Property Tax ID
• Preço de Compra: Valor total
• Depósito: Valor inicial, prazo, agente de escrow, depósito adicional
• Financiamento: Tipo e prazo para aprovação
• Datas: Fechamento, inspeção (padrão 15 dias), data efetiva
• Itens: Incluídos/excluídos da venda
• Assignability: Se é designável ou não

Etapa 2: Análise de Conformidade (CRÍTICA)

IMPORTANTE: Distinga entre campos preenchidos legitimamente e alterações maliciosas nas cláusulas.

NÃO CONSIDERE COMO ALTERAÇÕES:
• Campos em branco preenchidos (nomes, endereços, valores, datas)
• Campos "Other:" preenchidos nas seções apropriadas
• Checkboxes marcados conforme escolhas das partes
• Informações inseridas em linhas pontilhadas ou espaços designados

CONSIDERE COMO ALTERAÇÕES PERIGOSAS:
1. Texto de cláusulas modificado: Palavras, frases ou sentenças alteradas
2. Cláusulas removidas: Parágrafos inteiros eliminados
3. Cláusulas adicionadas: Novo texto inserido fora dos campos designados
4. Linguagem padrão alterada: Mudanças em direitos, obrigações ou prazos

Análise Contextual Obrigatória:
• Verifique se informações estão em campos apropriados (ex: "Transaction Fee" na seção 9(b) Other é normal)
• Compare apenas a linguagem das cláusulas, não os valores preenchidos
• Foque em alterações que mudem direitos, obrigações ou proteções legais

Se Conforme:
"Análise de Conformidade: Confirmei que todas as cláusulas correspondem à versão padrão oficial. Os campos foram preenchidos adequadamente. Nenhuma alteração maliciosa detectada."

Se Não Conforme:
"🚨 ALERTA DE NÃO CONFORMIDADE: Detectei alterações perigosas nas cláusulas padrão. Revise com advogado antes de prosseguir:
Cláusula [X] - MODIFICADA:
• Padrão: '[texto original da cláusula]'
• Enviado: '[texto alterado da cláusula]'
• Risco: [explicar impacto na proteção legal]"

Diretrizes Obrigatórias
• Foco: Apenas resumir fatos e verificar integridade - não opinar sobre qualidade da oferta
• Tom: Profissional, objetivo, focado em segurança
• Linguagem: Clara e direta, evitando jargões legais
• Precisão: Compare palavra por palavra com a versão oficial

Recomendação Final
⚖️ Disclaimer Automático
Aviso Importante: Esta análise é apenas um resumo comparativo baseado no modelo oficial do contrato "AS IS Residential Contract for Sale and Purchase" aprovado pela Florida Bar e Florida Realtors.

Não constitui aconselhamento jurídico nem substitui a orientação de um advogado.

Recomenda-se sempre a consulta a um advogado especializado em real estate na Flórida antes de assinar ou aceitar qualquer contrato.`;
      
      const requestPayload = {
        model: 'gpt-4',
        input: [
          {
            role: 'user',
            content: [
              { 
                type: 'input_file', 
                file_id: fileId 
              },
              { 
                type: 'input_text', 
                text: contractAnalysisPrompt
              }
            ]
          }
        ]
      };

      console.log(`📄 [PDF-PROCESSOR] 📝 Request payload:`, JSON.stringify(requestPayload, null, 2));
      console.log(`📄 [PDF-PROCESSOR] 🚀 Enviando para OpenAI Responses API...`);
      
      const analysisStartTime = Date.now();
      
      const gptResponse = await axios.post('https://api.openai.com/v1/responses', requestPayload, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000 // 2 minutos de timeout para análise
      });

      const analysisDuration = Date.now() - analysisStartTime;
      console.log(`📄 [PDF-PROCESSOR] ✅ Análise concluída em ${analysisDuration}ms`);
      console.log(`📄 [PDF-PROCESSOR] 📋 GPT Response status: ${gptResponse.status}`);
      
      // Extrair resposta do formato correto da nova API
      let assistantResponse;
      
      if (gptResponse.data.output && gptResponse.data.output.length > 0) {
        // Nova API responses format
        const outputContent = gptResponse.data.output[0].content;
        if (outputContent && outputContent.length > 0) {
          assistantResponse = outputContent.find(item => item.type === 'output_text')?.text;
        }
        console.log(`📄 [PDF-PROCESSOR] 📄 Response type: output[0].content[0].text`);
      } else {
        // Fallback para formato antigo
        assistantResponse = gptResponse.data.choices?.[0]?.message?.content;
        console.log(`📄 [PDF-PROCESSOR] 📄 Response type: choices[0].message.content (fallback)`);
      }
      
      console.log(`📄 [PDF-PROCESSOR] 📄 Response length: ${assistantResponse?.length || 0} characters`);
      console.log(`📄 [PDF-PROCESSOR] 📄 Response preview: ${assistantResponse?.substring(0, 200) || 'null'}...`);

      if (!assistantResponse) {
        console.error(`📄 [PDF-PROCESSOR] ❌ Resposta vazia da OpenAI`);
        console.error(`📄 [PDF-PROCESSOR] 🔍 Full response data:`, JSON.stringify(gptResponse.data, null, 2));
        throw new Error('Resposta vazia da OpenAI');
      }

      // Adicionar à conversa
      convo.history.push({ 
        role: 'user', 
        content: `[PDF: ${message.filename}] Documento enviado para análise.` 
      });
      convo.history.push({ 
        role: 'assistant', 
        content: assistantResponse 
      });

      console.log(`📄 [PDF-PROCESSOR] 📨 Enviando resposta para o usuário...`);
      // Enviar resposta da análise
      await client.sendText(sender, assistantResponse.trim());

      // Mensagem de encerramento
      setTimeout(async () => {
        await client.sendText(sender, 
          '✅ Análise concluída! A conversa foi encerrada e o bot voltou ao fluxo normal.\n\n' +
          'Para uma nova análise, envie novamente "TBV Anti Malandro" ou uma mensagem sobre análise de contratos.'
        );
      }, 2000);

      // Atualizar conversa
      CONVERSATIONS.set(convoKey, convo);

      // Log da atividade
      console.log(`📄 [PDF-PROCESSOR] ✅ PDF processado com sucesso para ${sender}`);

      // ✅ ENCERRAR CONVERSA APÓS ANÁLISE
      console.log(`📄 [PDF-PROCESSOR] 🔚 Encerrando conversa tbvvalidation...`);
      clearConversationTimeout(convoKey);
      CONVERSATIONS.delete(convoKey);
      console.log(`📄 [PDF-PROCESSOR] ✅ Conversa encerrada - bot voltou ao fluxo normal`);

      // Cleanup do arquivo OpenAI (opcional - os arquivos expiram automaticamente)
      console.log(`📄 [PDF-PROCESSOR] 🗑️ Limpando arquivo da OpenAI...`);
      try {
        await axios.delete(`https://api.openai.com/v1/files/${fileId}`, {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          }
        });
        console.log(`📄 [PDF-PROCESSOR] ✅ Arquivo ${fileId} removido da OpenAI`);
      } catch (deleteError) {
        console.warn(`📄 [PDF-PROCESSOR] ⚠️ Não foi possível deletar arquivo ${fileId}:`, deleteError.message);
      }

    } catch (apiError) {
      console.error(`📄 [PDF-PROCESSOR] ❌ Erro na API da OpenAI:`, apiError?.response?.status);
      console.error(`📄 [PDF-PROCESSOR] ❌ Erro detalhado:`, apiError?.response?.data || apiError.message);
      console.error(`📄 [PDF-PROCESSOR] ❌ Headers da resposta:`, apiError?.response?.headers);
      
      // Fallback: tentar com método tradicional
      try {
        console.log(`📄 [PDF-PROCESSOR] 🔄 Tentando fallback com chat/completions...`);
        
        // Usar método alternativo se a nova API falhar
        const fallbackPrompt = `Analise este documento PDF e identifique possíveis problemas legais, cláusulas suspeitas ou práticas questionáveis. O usuário enviou o arquivo: ${message.filename}`;
        
        const fallbackResponse = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [
            { role: 'system', content: loadPrompt('tbvantimalandro') },
            { role: 'user', content: fallbackPrompt }
          ],
          temperature: 0.2
        });

        const fallbackText = fallbackResponse.choices[0].message.content;
        console.log(`📄 [PDF-PROCESSOR] ✅ Fallback executado com sucesso`);
        await client.sendText(sender, fallbackText);
        
      } catch (fallbackError) {
        console.error(`📄 [PDF-PROCESSOR] ❌ Erro no fallback:`, fallbackError.message);
        await client.sendText(sender, 
          '❌ Não foi possível processar este PDF no momento. Tente novamente mais tarde ou envie um arquivo diferente.'
        );
      }
      
    } finally {
      // Limpar arquivo temporário
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          console.log(`📄 [PDF-PROCESSOR] 🗑️ Arquivo temporário removido: ${tempFilePath}`);
        }
      } catch (cleanupError) {
        console.warn(`📄 [PDF-PROCESSOR] ⚠️ Erro ao limpar arquivo temporário:`, cleanupError.message);
      }
    }

    // Salvar log da sessão
    try {
      const whatsappNumero = normalizeToWhatsAppNumber(sessionName);
      await saveSessionLog({
        email: session.email,
        sessaoNumero: sessionName,
        whatsappNumero
      });
      console.log(`📄 [PDF-PROCESSOR] ✅ Log de sessão salvo`);
    } catch (err) {
      console.error(`📄 [PDF-PROCESSOR] ❌ Erro ao gravar log de sessão:`, err);
    }

  } catch (error) {
    console.error(`📄 [PDF-PROCESSOR] ❌ Erro geral no processamento:`, error);
    console.error(`📄 [PDF-PROCESSOR] ❌ Stack trace:`, error.stack);
    
    try {
      const session = SESSIONS.get(sessionName);
      if (session && session.client) {
        await session.client.sendText(message.from, 
          '❌ Ocorreu um erro ao processar seu documento. Tente novamente ou envie um arquivo diferente.'
        );
      }
    } catch (sendError) {
      console.error(`📄 [PDF-PROCESSOR] ❌ Erro ao enviar mensagem de erro:`, sendError);
    }
  }

  console.log(`📄 [PDF-PROCESSOR] 🏁 Processamento finalizado para ${sessionName}`);
}
// ATUALIZAR: processBotAudio (aplicar as mesmas modificações)
// FUNÇÃO processBotAudio ORIGINAL + TIMEOUT
async function processBotAudio(sessionName, message) {
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

    console.log(`🤖 Processando áudio direcionado ao bot na sessão ${sessionName}...`);

    let buffer = await client.decryptFile(message);
    let transcript = '';
    let trigger = 'nenhum';

    const convoKey = `${myNumber}:${message.from}`;
    const stored = CONVERSATIONS.get(convoKey);

    try {
      // Executar checkTriggerInAudio para mensagens do bot
      const triggerResult = await checkTriggerInAudio(
        buffer,
        sessionName.replace(/\W/g, ''),
        message.id,
        message
      );
      
      trigger = triggerResult.trigger;
      transcript = triggerResult.transcript;

      // 🛑 1) Comando explícito para desligar o bot (via áudio)
      if (transcript && transcript.toLowerCase().trim() === 'tbvoff') {
        if (stored?.activeTrigger) {
          // ✅ NOVO: Limpar timeout quando bot é desativado via áudio
          clearConversationTimeout(convoKey);
          await client.sendText(message.from, '🔕 Bot desativado. Você voltou ao fluxo normal.');
          CONVERSATIONS.delete(convoKey);
        } else {
          await client.sendText(message.from, 'Nenhum bot ativo para desativar.');
        }
        return;
      }

      // 🛑 2) Triggers de encerramento por desinteresse (via áudio)
      const endRegex = /^(eu desisti|não tenho mais interesse|nao tenho mais interesse|já entendi|ja entendi|até mais|ate mais|fim)$/i;
      if (transcript && stored?.activeTrigger && endRegex.test(transcript.trim())) {
        // ✅ NOVO: Limpar timeout quando conversa é encerrada via áudio
        clearConversationTimeout(convoKey);
        await client.sendText(message.from, 'Obrigado pela conversa. Até mais!');
        CONVERSATIONS.delete(convoKey);
        return;
      }

      // ✅ 3) Se há fluxo ativo, delega direto ao handler (via áudio)
      if (transcript && stored?.activeTrigger && TRIGGERS[stored.activeTrigger]) {
        console.log(`[processBotAudio] Continuando conversa ativa: ${stored.activeTrigger}`);
        // ✅ NOVO: Renovar timeout a cada áudio no fluxo ativo
        refreshConversationTimeout(convoKey, session, message.from);
        await TRIGGERS[stored.activeTrigger](session, message, transcript, sessionName, email);
        return;
      }

      // ✅ 4) Se trigger foi identificado, executar o fluxo
      if (trigger !== 'nenhum') {
        console.log(`[processBotAudio] Trigger identificado no áudio: ${trigger}`);

        // Verificar se é um trigger válido
        const valid = {
          tbvevents:          'tbvevents',
          tbvmortgage:        'tbvmortgage',
          tbvrentabilidade:   'tbvrentabilidade',
          tbvprequalificacao: 'tbvprequalificacao',
          tbvconstruction:    'tbvconstruction',
          tbvconstrucao:      'tbvconstruction'
        };

        const normalizedTrigger = trigger.toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, '');

        // Aplicar sinônimos
        const synonyms = { tbvmortage: 'tbvmortgage' };
        let finalTrigger = synonyms[normalizedTrigger] || normalizedTrigger;

        if (valid[finalTrigger]) {
          const trigKey = valid[finalTrigger];
          console.log(`[processBotAudio] Disparando trigger: ${trigKey}`);
          
          // Configurar conversa ativa
          CONVERSATIONS.set(convoKey, { history: [], activeTrigger: trigKey });
          
          // ✅ NOVO: Definir timeout quando nova conversa é iniciada via áudio
          setConversationTimeout(convoKey, session, message.from);
          
          // Chamar o trigger com o transcript como texto
          if (TRIGGERS[trigKey]) {
            await TRIGGERS[trigKey](session, message, transcript, sessionName, email);
            return;
          }
        } else {
          console.log(`[processBotAudio] Trigger não reconhecido: '${finalTrigger}'`);
        }
      }

      // Se chegou até aqui e não há trigger específico, enviar mensagem padrão do bot
      if (transcript && transcript.trim().length > 0) {
        await client.sendText(message.from, 
          `Olá! Sou o assistente TBV. Para começar, você pode dizer:\n\n` +
          `• "TBV Events" - Para eventos imobiliários\n` +
          `• "TBV Mortgage" - Para financiamentos\n` +
          `• "TBV Rentabilidade" - Para análise de investimentos\n` +
          `• "TBV Pré-qualificação" - Para pré-aprovação\n` +
          `• "TBV Construction" - Para construção\n\n` +
          `Como posso ajudá-lo hoje?`
        );
      }

    } catch (triggerError) {
      console.error('❌ Erro ao processar triggers do bot:', triggerError.message);
      await client.sendText(message.from, 'Desculpe, houve um erro ao processar sua mensagem. Tente novamente.');
    }

    // ✅ LOGGING para mensagens do bot
    try {
      const whatsappNumero = normalizeToWhatsAppNumber(sessionName);
      await saveSessionLog({
        email: session.email,
        sessaoNumero: sessionName,
        whatsappNumero
      });
      console.log('✅ Log de sessão do bot salvo no banco.');
    } catch (err) {
      console.error('❌ Erro ao gravar log de sessão do bot no banco:', err);
    }

  } catch (error) {
    console.error('❌ Erro ao processar áudio do bot:', error?.response?.data || error.message);
    try {
      await client.sendText(message.from, 'Desculpe, ocorreu um erro interno. Tente novamente mais tarde.');
    } catch (sendError) {
      console.error('❌ Erro ao enviar mensagem de erro:', sendError.message);
    }
  }
}

// ===== FUNÇÃO DE LIMPEZA GERAL =====

/**
 * Limpa todos os timeouts ativos (útil para shutdown do servidor)
 */
function clearAllConversationTimeouts() {
  console.log(`🧹 Limpando ${CONVERSATION_TIMEOUTS.size} timeouts ativos...`);
  
  for (const [convoKey, timeoutInfo] of CONVERSATION_TIMEOUTS.entries()) {
    clearTimeout(timeoutInfo.timeoutId);
    console.log(`🔄 Timeout limpo para: ${convoKey}`);
  }
  
  CONVERSATION_TIMEOUTS.clear();
  console.log('✅ Todos os timeouts foram limpos');
}

// ===== MONITORAMENTO (OPCIONAL) =====

/**
 * Função de debug para listar conversas ativas com timeouts
 */
function listActiveConversationsWithTimeouts() {
  console.log('\n📊 === CONVERSAS ATIVAS COM TIMEOUTS ===');
  
  if (CONVERSATION_TIMEOUTS.size === 0) {
    console.log('Nenhuma conversa com timeout ativo.');
    return;
  }
  
  for (const [convoKey, timeoutInfo] of CONVERSATION_TIMEOUTS.entries()) {
    const info = getTimeoutInfo(convoKey);
    const conversation = CONVERSATIONS.get(convoKey);
    
    console.log(`🔹 ${convoKey}`);
    console.log(`   Trigger: ${conversation?.activeTrigger || 'N/A'}`);
    console.log(`   Tempo restante: ${info.remaining}s`);
    console.log(`   Número: ${info.senderNumber}`);
    console.log('');
  }
  
  console.log('=====================================\n');
}

// Executar monitoramento a cada 5 minutos (opcional)
setInterval(() => {
  if (CONVERSATION_TIMEOUTS.size > 0) {
    listActiveConversationsWithTimeouts();
  }
}, 5 * 60 * 1000);

// Limpeza na finalização do processo
process.on('SIGINT', () => {
  console.log('\n🛑 Recebido SIGINT, limpando timeouts...');
  clearAllConversationTimeouts();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Recebido SIGTERM, limpando timeouts...');
  clearAllConversationTimeouts();
  process.exit(0);
});


// Função processAudio modificada - focada apenas na transcrição normal
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

    console.log(`📱 Processando áudio normal (transcrição) na sessão ${sessionName}...`);

    let buffer = await client.decryptFile(message);
    let transcript = '';

    // ✅ FLUXO NORMAL DE TRANSCRIÇÃO
    const filtros = await loadFiltersFromDB(email, sessionName);
    const contact = await client.getContact(message.from);
    const senderName = contact.name || contact.pushname || message.from;

    console.log(`🔊 Processando áudio de ${senderName} na sessão ${sessionName}...`);

    const sessionSafe = sessionName.replace(/\W/g, '');
    const inputPath = path.join(AUDIO_DIR, `${sessionSafe}_${message.id}.ogg`);
    const denoisedPath = path.join(AUDIO_DIR, `${sessionSafe}_${message.id}_clean.ogg`);

    // Salvar arquivo para processamento de áudio
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(inputPath);
      stream.write(buffer, (err) => {
        if (err) {
          console.error('❌ Erro ao salvar arquivo de áudio:', err);
          reject(err);
        } else {
          resolve();
        }
      });
      stream.end();
    });

    // Liberar buffer da memória
    buffer = null;

    // Processamento de áudio com FFmpeg
    try {
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', ['-i', inputPath, '-af', 'afftdn', '-y', denoisedPath]);
        
        ffmpeg.stderr.on('data', (data) => {
          // Log opcional do FFmpeg apenas se necessário para debug
        });
        
        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            console.error(`❌ FFmpeg falhou com código: ${code}`);
            reject(new Error(`FFmpeg exited with code ${code}`));
          }
        });
        
        ffmpeg.on('error', (err) => {
          console.error('❌ Erro no FFmpeg:', err);
          reject(err);
        });
      });
    } catch (ffmpegError) {
      console.error('❌ Erro no processamento FFmpeg:', ffmpegError.message);
      // Use o arquivo original se FFmpeg falhar
      fs.copyFileSync(inputPath, denoisedPath);
    }

    const duration = await getAudioDuration(denoisedPath);
    console.log(`Audio de ${parseFloat(duration.toFixed(2))} sec`);

    // ✅ TRANSCRIÇÃO
    console.log('🔄 Fazendo transcrição do áudio...');
    
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(denoisedPath));
      formData.append('model', 'whisper-1');
      formData.append('language', 'pt'); // Forçar português para melhor precisão

      const transcriptionResponse = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions', 
        formData, 
        {
          headers: {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          },
          timeout: 30000 // 30 segundos de timeout
        }
      );

      transcript = transcriptionResponse.data.text;
      
      if (!transcript || typeof transcript !== 'string') {
        throw new Error('Transcript inválido da API');
      }
      
      transcript = transcript.trim();
      console.log('✅ Transcrição obtida:', transcript.substring(0, 50) + '...');
      
    } catch (transcriptionError) {
      console.error('❌ Erro na transcrição:', transcriptionError.message);
      
      // Tentar fallback sem especificar idioma
      try {
        const formDataFallback = new FormData();
        formDataFallback.append('file', fs.createReadStream(denoisedPath));
        formDataFallback.append('model', 'whisper-1');

        const fallbackResponse = await axios.post(
          'https://api.openai.com/v1/audio/transcriptions', 
          formDataFallback, 
          {
            headers: {
              ...formDataFallback.getHeaders(),
              'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
          }
        );

        transcript = fallbackResponse.data.text?.trim() || '';
        console.log('✅ Transcrição obtida (fallback):', transcript.substring(0, 50) + '...');
        
      } catch (fallbackError) {
        console.error('❌ Erro na transcrição fallback:', fallbackError.message);
        
        // ✅ LIMPEZA DE ARQUIVOS EM CASO DE ERRO DE TRANSCRIÇÃO
        const filesToClean = [inputPath, denoisedPath];
        for (const filePath of filesToClean) {
          try {
            if (fs.existsSync(filePath)) {
              await fs.promises.unlink(filePath);
            }
          } catch (err) {
            console.warn(`⚠️ Não foi possível deletar ${filePath}: ${err.message}`);
          }
        }
        return;
      }
    }

    // Verificar se temos transcript válido
    if (!transcript || transcript.trim().length === 0) {
      console.error('❌ Transcript final vazio após todas as tentativas');
      await client.sendText(message.from, 'Não foi possível transcrever o áudio.', { quotedMsg: message.id });
      
      // ✅ LIMPEZA DE ARQUIVOS EM CASO DE TRANSCRIPT VAZIO
      const filesToClean = [inputPath, denoisedPath];
      for (const filePath of filesToClean) {
        try {
          if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
          }
        } catch (err) {
          console.warn(`⚠️ Não foi possível deletar ${filePath}: ${err.message}`);
        }
      }
      return;
    }

    // ✅ PROCESSAMENTO COM GPT
    let languagePrompt = '';
    if (filtros.translation_enabled) {
      switch (filtros.language) {
        case 'pt-br': 
          languagePrompt = 'OBRIGATORIAMENTE traduzir TODO o conteúdo para português brasileiro. Se o áudio já estiver em português, apenas corrija a gramática mantendo o idioma português'; 
          break;
        case 'en-us': 
          languagePrompt = 'OBRIGATORIAMENTE traduzir TODO o conteúdo para inglês americano. Se o áudio já estiver em inglês, apenas corrija a gramática mantendo o idioma inglês'; 
          break;
        case 'es-es': 
          languagePrompt = 'OBRIGATORIAMENTE traduzir TODO o conteúdo para espanhol. Se o áudio já estiver em espanhol, apenas corrija a gramática mantendo o idioma espanhol'; 
          break;
        default: 
          console.warn('Idioma não reconhecido para tradução:', filtros.language);
      }
    }

    // Construção dos prompts
    let prompt_base = '';
    if (filtros.summarizeMessages && filtros.longmessage) {
      prompt_base = `Você é um assistente de IA especializado em processamento de transcrições de áudio. ${languagePrompt ? languagePrompt + '. ' : ''}Após processar o idioma conforme solicitado, corrija a gramática, mantenha o conteúdo original e liste os tópicos principais. Pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
    } else if (filtros.summarizeMessages) {
      prompt_base = `Você é um assistente de IA especializado em processamento de transcrições de áudio. ${languagePrompt ? languagePrompt + '. ' : ''}Após processar o idioma conforme solicitado, corrija a gramática e liste os tópicos principais. Pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
    } else if (filtros.longmessage) {
      prompt_base = `Você é um assistente de IA especializado em processamento de transcrições de áudio. ${languagePrompt ? languagePrompt + '. ' : ''}Após processar o idioma conforme solicitado, corrija a gramática mantendo o texto original o máximo possível. Pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
    } else {
      prompt_base = `Você é um assistente de IA especializado em processamento de transcrições de áudio. ${languagePrompt ? languagePrompt + '. ' : ''}Após processar o idioma conforme solicitado, corrija apenas a gramática do texto. Pule 2 linhas e adicione ao final: "Transcribed by Thebroker.vip", a menos que essa frase já esteja presente.`;
    }

    const recipient = (filtros.sendForward === true || filtros.sendForward === '1' || filtros.sendForward === 1)
      ? myNumber
      : message.from;

    // Limpar dados para a API
    const cleanTranscript = String(transcript).trim();
    const cleanPromptBase = String(prompt_base).trim() || 'Você é um assistente de IA especializado em processamento de transcrições de áudio. Corrija apenas a gramática do texto.';

    // ✅ PROCESSAMENTO COM GPT-4.1
    let finalMessage = '';
    
    try {
      console.log('🔄 Processando com GPT-4.1...');
      
      const requestPayload = {
        model: 'gpt-4.1',
        messages: [
          { 
            role: "system", 
            content: cleanPromptBase
          },
          { 
            role: "user", 
            content: cleanTranscript
          }
        ],
        temperature: 0.1,
      };

      const response_gpt = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        requestPayload,
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
        }
      );

      finalMessage = response_gpt.data.choices[0].message.content;
      console.log('✅ Processamento bem-sucedido com GPT-4.1');
      
    } catch (apiError) {
      console.error('❌ Erro no processamento GPT-4.1:', apiError?.response?.data || apiError.message);
      
      // Fallback simples: apenas corrigir gramática básica
      try {
        console.log('🔄 Usando processamento simples...');
        finalMessage = await simpleTextProcessing(cleanTranscript, filtros);
      } catch (fallbackError) {
        console.error('❌ Erro no fallback simples:', fallbackError.message);
        // Último recurso: enviar transcript original
        finalMessage = `Transcrição: ${cleanTranscript}\n\nTranscribed by Thebroker.vip`;
      }
    }
    
    // Enviar resultado final
    try {
      //await client.markPlayed(message.id); # Marcar mensagem como lida
      await client.sendText(recipient, finalMessage, { quotedMsg: message.id });
      console.log('✅ Mensagem enviada com sucesso');
    } catch (sendError) {
      console.error('❌ Erro ao enviar mensagem:', sendError.message);
    }

    // ✅ LIMPEZA DE ARQUIVOS APENAS APÓS SUCESSO COMPLETO
    const filesToClean = [inputPath, denoisedPath];
    for (const filePath of filesToClean) {  
      try {
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
        }
      } catch (err) {
        console.warn(`⚠️ Não foi possível deletar ${filePath}: ${err.message}`);
      }
    }

    // ✅ LOGGING
    try {
      const whatsappNumero = normalizeToWhatsAppNumber(sessionName);
      await saveSessionLog({
        email: session.email,
        sessaoNumero: sessionName,
        whatsappNumero
      });
      console.log('✅ Log de sessão salvo no banco.');
    } catch (err) {
      console.error('❌ Erro ao gravar log de sessão no banco:', err);
    }

    try {
      const logData = {
        email: session.email,
        numero: sessionName,
        ultimo_acesso: new Date().toISOString().replace('T', ' ').substring(0, 19)
      };
      
      const logFilePath = path.join(SESSION_LOGS_DIR, `${sessionName}.json`);
      fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2), 'utf8');
      console.log(`Log atualizado para a sessão ${sessionName}`);
    } catch (err) {
      console.error(`Falha ao salvar log para ${sessionName}:`, err);
    }

  } catch (error) {
    console.error('❌ Erro ao processar áudio:', error?.response?.data || error.message);
    
    // ✅ LIMPEZA DE ARQUIVOS EM CASO DE ERRO GERAL
    try {
      const sessionSafe = sessionName.replace(/\W/g, '');
      const inputPath = path.join(AUDIO_DIR, `${sessionSafe}_${message.id}.ogg`);
      const denoisedPath = path.join(AUDIO_DIR, `${sessionSafe}_${message.id}_clean.ogg`);
      
      const filesToClean = [inputPath, denoisedPath];
      for (const filePath of filesToClean) {
        try {
          if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
          }
        } catch (err) {
          console.warn(`⚠️ Não foi possível deletar ${filePath}: ${err.message}`);
        }
      }
    } catch (cleanupError) {
      console.error('❌ Erro durante limpeza:', cleanupError.message);
    }
  }
}

// ✅ FUNÇÃO DE PROCESSAMENTO SIMPLES COMO FALLBACK
async function simpleTextProcessing(transcript, filtros) {
  try {
    let processedText = transcript.trim();
    
    // Aplicar correções básicas de gramática
    processedText = processedText
      // Capitalizar primeira letra de frases
      .replace(/^[a-z]/, match => match.toUpperCase())
      .replace(/\. [a-z]/g, match => match.toUpperCase())
      .replace(/\? [a-z]/g, match => match.toUpperCase())
      .replace(/! [a-z]/g, match => match.toUpperCase())
      // Remover espaços duplos
      .replace(/\s+/g, ' ')
      // Garantir pontuação no final
      .replace(/[^\.\!\?]$/, match => match + '.');
    
    // Aplicar tradução básica se necessário
    if (filtros.translation_enabled && filtros.language === 'en-us') {
      // Fallback para tradução básica (apenas alguns casos comuns)
      const basicTranslations = {
        'olá': 'hello',
        'oi': 'hi',
        'tchau': 'bye',
        'obrigado': 'thank you',
        'obrigada': 'thank you',
        'sim': 'yes',
        'não': 'no',
        'bom dia': 'good morning',
        'boa tarde': 'good afternoon',
        'boa noite': 'good evening'
      };
      
      for (const [pt, en] of Object.entries(basicTranslations)) {
        processedText = processedText.replace(new RegExp(`\\b${pt}\\b`, 'gi'), en);
      }
    }
    
    // Adicionar assinatura
    if (!processedText.includes('Transcribed by Thebroker.vip')) {
      processedText += '\n\nTranscribed by Thebroker.vip';
    }
    
    return processedText;
    
  } catch (error) {
    console.error('❌ Erro no processamento simples:', error.message);
    return `${transcript}\n\nTranscribed by Thebroker.vip`;
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
    const { id, nome, trigger, prompt, modelo = 'gpt-4.1', ativo = 1 } = req.body;

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
  // carrega apenas as instruções de sistema
  const rawPrompt = loadPrompt('TBV-Router');

  // aqui só enviamos a mensagem do usuário
  const userContent = `Mensagem:\n"""${text}"""`;

  const result = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: rawPrompt },
      { role: 'user', content: userContent }
    ]
  }, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  const resposta = result.data.choices[0].message.content.trim();
  console.log(`[checkTriggerInText] Resposta do GPT: ${resposta}`);
  return resposta;
}



// ATUALIZAR: processText
// FUNÇÃO processText ORIGINAL + TIMEOUT
async function processText(sessionName, message, email) {
  try {
    const session = SESSIONS.get(sessionName);
    if (!session) throw new Error(`Sessão ${sessionName} não encontrada.`);
    const { client, myNumber } = session;
    if (!myNumber) return;
    if (message.from === myNumber) return;
    if (message.to !== MAIN_BOT_NUMBER) return;

    const text = message.body?.trim();
    if (!text) return;
    const convoKey = `${session.myNumber}:${message.from}`;
    const stored   = CONVERSATIONS.get(convoKey);

    // 🛑 1) Comando explícito para desligar o bot
    if (text.toLowerCase() === 'tbvoff') {
      if (stored?.activeTrigger) {
        // ✅ NOVO: Limpar timeout quando bot é desativado manualmente
        clearConversationTimeout(convoKey);
        await client.sendText(message.from, '🔕 Bot desativado. Você voltou ao fluxo normal.');
        CONVERSATIONS.delete(convoKey);
      } else {
        await client.sendText(message.from, 'Nenhum bot ativo para desativar.');
      }
      return;
    }

    // 🛑 2) Triggers de encerramento por desinteresse
    const endRegex = /^(eu desisti|não tenho mais interesse|nao tenho mais interesse|já entendi|ja entendi|até mais|ate mais|fim)$/i;
    if (stored?.activeTrigger && endRegex.test(text)) {
      // ✅ NOVO: Limpar timeout quando conversa é encerrada
      clearConversationTimeout(convoKey);
      await client.sendText(message.from, 'Obrigado pela conversa. Até mais!');
      CONVERSATIONS.delete(convoKey);
      return;
    }

    // ✅ 3) Se há fluxo ativo, delega direto ao handler
    if (stored?.activeTrigger && TRIGGERS[stored.activeTrigger]) {
      // ✅ NOVO: Renovar timeout a cada mensagem no fluxo ativo
      refreshConversationTimeout(convoKey, session, message.from);
      return TRIGGERS[stored.activeTrigger](session, message, text, sessionName, email);
    }

    // 🤖 4) Classifica via GPT
    const raw = (await checkTriggerInText(text)).trim();

    // limpa backticks, aspas, etc.
    let cleaned = raw
      .replace(/```/g, '')
      .replace(/`/g, '')
      .replace(/(^["']|["']$)/g, '')
      .trim();

    // remove tudo que não for [a–z0–9]
    let norm = cleaned
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');

    const synonyms = { tbvmortage: 'tbvmortgage' };
    if (synonyms[norm]) {
      console.log(`[processText] applying synonym: ${norm} → ${synonyms[norm]}`);
      norm = synonyms[norm];
    }

    // 📋 fallback de menu padrão
    if (norm.startsWith('nenhumbotativado')) {
      await client.sendText(message.from, cleaned);
      return;
    }

    // 🚀 dispara um dos 5 triggers válidos
    const valid = {
      tbvevents:          'tbvevents',
      tbvmortgage:        'tbvmortgage',
      tbvrentabilidade:   'tbvrentabilidade',
      tbvprequalificacao: 'tbvprequalificacao',
      tbvconstruction:    'tbvconstruction',
      tbvconstrucao:      'tbvconstruction',
      tbvvalidation:      'tbvvalidation',
      tbvbusinesscard:    'tbvbusinesscard',
      tbvesperardolar:    'tbvesperardolar',
      tbvesperarjuros:    'tbvesperarjuros',
    };

    if (valid[norm]) {
      const trigKey = valid[norm];
      console.log(`[processText] dispatching trigger: ${trigKey}`);
      CONVERSATIONS.set(convoKey, { history: [], activeTrigger: trigKey });
      
      // ✅ NOVO: Definir timeout quando nova conversa é iniciada via texto
      setConversationTimeout(convoKey, session, message.from);
      
      return TRIGGERS[trigKey](session, message, text, sessionName, email);
    }

    // 🛑 caso não reconheça
    console.log(`[processText] unrecognized trigger: '${norm}'`);
  }
  catch (err) {
    console.error(`❌ Erro em processText: ${err.message}`, err.stack);
  }
}

async function processImage(sessionName, message, email) {
  try {
    const session = SESSIONS.get(sessionName);
    if (!session) throw new Error(`Sessão ${sessionName} não encontrada.`);
    const { client, myNumber } = session;
    if (!myNumber) return;
    if (message.from === myNumber) return;
    if (message.to !== MAIN_BOT_NUMBER) return;

    const sender   = message.from;
    const convoKey = `${session.myNumber}:${sender}`;

    // Garante que é imagem
    const isImage =
      message.type === 'image' ||
      (message.mimetype && message.mimetype.startsWith('image/'));

    if (!isImage) {
      console.log(`[processImage] Mensagem não é imagem. type=${message.type}, mimetype=${message.mimetype}`);
      return;
    }

    console.log(`🖼️ [processImage] Recebendo imagem de ${sender} (${message.mimetype || message.type})`);

    // 1) Decodifica a imagem
    const imageBuffer = await client.decryptFile(message);
    const base64Image = imageBuffer.toString('base64');
    const mime = message.mimetype || 'image/jpeg';

    // 2) Prompt de análise de imagem (em PT-BR, conforme pedido)
    const IMAGE_ANALYSIS_PROMPT = `Você é um modelo especializado em análise e descrição de imagens.

Sempre que receber uma imagem, analise-a minuciosamente e produza uma descrição completa, estruturada e precisa do conteúdo visual.

Sua resposta deve conter:

Descrição geral: o que a imagem representa (ex: uma paisagem, uma pessoa, uma interface, um documento, um gráfico, etc.).

Elementos visuais: identifique pessoas, objetos, textos, cores predominantes, ambiente e composição (ex: iluminação, perspectiva, enquadramento).

Contexto e intenção provável: o propósito possível da imagem (ex: foto de produto, cena turística, captura de tela de sistema, diagrama técnico, etc.).

Detalhes textuais (OCR leve): se houver texto visível, transcreva-o e descreva sua posição e formato (ex: títulos, legendas, botões).

Análise técnica (se aplicável): tipo de arquivo ou estilo visual (ex: foto, ilustração digital, screenshot, render 3D, pintura, etc.).

Tom e atmosfera: sensações que a imagem transmite (ex: profissional, relaxante, caótico, tecnológico, artístico, publicitário).

⚙️ Regras de comportamento:

Nunca invente informações não visíveis.
Seja objetivo e observador, mas descreva com profundidade.
Use frases completas, sem bullet points a menos que solicitado.
Se a imagem estiver ilegível ou parcial, diga claramente o que é visível e o que não é possível identificar.
Nunca emita julgamentos pessoais ou interpretações emocionais sem base visual.

✅ Exemplo de saída esperada:
“A imagem mostra uma sala de estar moderna, com um sofá cinza em primeiro plano e uma mesa de centro de vidro. Ao fundo há uma TV montada na parede e uma estante com livros. A iluminação é natural, vinda de uma janela à esquerda. O estilo geral é minimalista e contemporâneo, possivelmente de um catálogo de imóveis.”`;

    // 3) Chama o GPT (visão) para descrever a imagem
    console.log(`🖼️ [processImage] Chamando OpenAI (gpt-4.1 visão) para descrição...`);
    const gptResponse = await axios.post('https://api.openai.com/v1/responses', {
      model: 'gpt-4.1',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text',  text: IMAGE_ANALYSIS_PROMPT },
            { type: 'input_image', image_url: `data:${mime};base64,${base64Image}` }
          ]
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    });

    // 4) Extrai texto da resposta
    let description;
    if (gptResponse.data?.output?.length > 0) {
      const outputContent = gptResponse.data.output[0]?.content || [];
      description = outputContent.find(item => item.type === 'output_text')?.text;
    }
    if (!description) {
      // fallback p/ formato compatível com chat-completions
      description = gptResponse.data?.choices?.[0]?.message?.content;
    }
    if (!description) {
      throw new Error('Resposta vazia da OpenAI ao analisar a imagem.');
    }

    console.log(`🖼️ [processImage] Descrição gerada (preview): ${description.substring(0, 160)}...`);

    // (Opcional) envia a descrição para o usuário
    try {
      await client.sendText(sender, description);
    } catch (sendErr) {
      console.error('⚠️ [processImage] Falha ao enviar descrição para o usuário:', sendErr);
    }

    // 5) Usa o seu roteador para detectar gatilho a partir da descrição
    const rawTrigger = (await checkTriggerInText(description)).trim();
    console.log(`[processImage] checkTriggerInText => "${rawTrigger}"`);

    // 6) Normaliza mesma lógica do processText
    let cleaned = rawTrigger
      .replace(/```/g, '')
      .replace(/`/g, '')
      .replace(/(^["']|["']$)/g, '')
      .trim();

    let norm = cleaned
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');

    const synonyms = { tbvmortage: 'tbvmortgage' };
    if (synonyms[norm]) {
      console.log(`[processImage] applying synonym: ${norm} → ${synonyms[norm]}`);
      norm = synonyms[norm];
    }

    // 7) Fallback "nenhumbotativado"
    if (norm.startsWith('nenhumbotativado')) {
      // encaminha o texto retornado (ex: menu padrão)
      try {
        await client.sendText(sender, cleaned);
      } catch (sendErr) {
        console.error('⚠️ [processImage] Falha ao enviar fallback ao usuário:', sendErr);
      }
      return;
    }

    // 8) Dispara triggers válidos (mesmo mapa do processText)
    const valid = {
      tbvevents:          'tbvevents',
      tbvmortgage:        'tbvmortgage',
      tbvrentabilidade:   'tbvrentabilidade',
      tbvprequalificacao: 'tbvprequalificacao',
      tbvconstruction:    'tbvconstruction',
      tbvconstrucao:      'tbvconstruction',
      tbvvalidation:      'tbvvalidation',
      tbvbusinesscard:    'tbvbusinesscard',
      tbvesperardolar:    'tbvesperardolar',
      tbvesperarjuros:    'tbvesperarjuros',
    };

    if (valid[norm]) {
      const trigKey = valid[norm];
      console.log(`[processImage] dispatching trigger: ${trigKey}`);

      CONVERSATIONS.set(convoKey, { history: [], activeTrigger: trigKey });
      setConversationTimeout(convoKey, session, sender);

      return TRIGGERS[trigKey](session, message, description, sessionName, email);
    }

    // 9) Caso não reconheça nenhum trigger
    console.log(`[processImage] unrecognized trigger from image: '${norm}'`);
    // opcional: avisa o usuário que não houve roteamento
    try {
      await client.sendText(sender, 'ℹ️ Análise concluída, mas não identifiquei um contexto específico para continuar. Se quiser, me diga o que deseja fazer.');
    } catch (sendErr) {
      console.error('⚠️ [processImage] Falha ao enviar aviso de contexto não reconhecido:', sendErr);
    }
  } catch (err) {
    console.error(`❌ Erro em processImage: ${err.message}`, err.stack);
    // fallback amistoso pro usuário
    try {
      const session = SESSIONS.get(sessionName);
      if (session?.client && message?.from) {
        await session.client.sendText(message.from, '❌ Não consegui analisar esta imagem agora. Pode tentar novamente com outra foto?');
      }
    } catch (sendErr) {
      console.error('⚠️ [processImage] Falha ao enviar fallback de erro ao usuário:', sendErr);
    }
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


// ✅ FUNÇÃO restoreSession DEVE ESTAR FORA E ANTES de restoreSessions
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

    let myNumber = null;

    try {
      await client.isConnected();
      myNumber = await client.getWid();
      console.log(`📱 Número recuperado imediatamente após criação: ${myNumber}`);


      if (myNumber === MAIN_BOT_NUMBER) {
        console.log('▶️ Bot principal restaurado — agendando checagem de lembretes...');
        startReminderChecks(client);
      }


      await criarOuIgnorarSessao(sessionName, email);
      console.log(`✅ Sessão '${sessionName}' registrada no banco (restauração).`);
    } catch (err) {
      console.warn(`⚠️ Falha ao recuperar myNumber logo após criação da sessão ${sessionName}:`, err.message);
    }


    if (!SESSIONS.has(sessionName)) {
      SESSIONS.set(sessionName, { 
        client, 
        myNumber, 
        email,
        lastStatusCheck: Date.now(),
        consecutiveFailures: 0,
        isHealthy: true
      });
    } else {
      console.warn(`⚠️ SESSIONS já possui ${sessionName}. Evitando sobrescrever.`);
    }

    
    const statusCheckInterval = setInterval(async () => {
      try {
        const session = SESSIONS.get(sessionName);
        if (!session) {
          console.warn(`⚠️ Sessão ${sessionName} não encontrada no SESSIONS, removendo interval`);
          clearInterval(statusCheckInterval);
          return;
        }

        let currentState = 'DISCONNECTED'; // Default para desconectado
        let checkSuccessful = false;

        try {
          // Tenta múltiplas verificações de status
          const connectionPromises = [
            session.client.getConnectionState(),
            session.client.isConnected().then(connected => connected ? 'CONNECTED' : 'DISCONNECTED'),
          ];

          // Timeout de 10 segundos para verificação
          const statusResult = await Promise.race([
            Promise.all(connectionPromises),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Status check timeout')), 10000)
            )
          ]);

          currentState = statusResult[0] || statusResult[1];
          checkSuccessful = true;
          
          // Reset contador de falhas em caso de sucesso
          session.consecutiveFailures = 0;
          session.isHealthy = true;
          session.lastStatusCheck = Date.now();

        } catch (statusError) {
          console.warn(`⚠️ Falha ao verificar status de ${sessionName}:`, statusError.message);
          
          // Incrementa contador de falhas consecutivas
          session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;
          
          // Após 3 falhas consecutivas, considera a sessão como desconectada
          if (session.consecutiveFailures >= 3) {
            currentState = 'DISCONNECTED';
            session.isHealthy = false;
            console.error(`❌ Sessão ${sessionName} com ${session.consecutiveFailures} falhas consecutivas, marcando como DISCONNECTED`);
          }
        }

        // Sempre tenta atualizar o status no banco
        try {
          await atualizarStatusSessao(sessionName, currentState);
          console.log(`🔄 [${sessionName}] status atualizado: ${currentState} (${checkSuccessful ? 'verificado' : 'assumido'})`);
        } catch (dbError) {
          console.error(`❌ Erro ao atualizar status no banco para ${sessionName}:`, dbError.message);
        }

        // Se a sessão está consistentemente desconectada, limpa
        if (!session.isHealthy && session.consecutiveFailures >= 5) {
          console.warn(`🧹 Limpando sessão ${sessionName} devido a falhas persistentes`);
          clearInterval(statusCheckInterval);
          await cleanupSession(sessionName);
        }

      } catch (err) {
        console.error(`❌ Erro crítico no monitoramento de ${sessionName}:`, err);
        
        // Em caso de erro crítico, força atualização como DISCONNECTED
        try {
          await atualizarStatusSessao(sessionName, 'DISCONNECTED');
          console.log(`🔄 [${sessionName}] forçado para DISCONNECTED devido a erro crítico`);
        } catch (dbErr) {
          console.error(`❌ Falha ao forçar status DISCONNECTED para ${sessionName}:`, dbErr);
        }
      }
    }, 30_000);

    // Salva referência do interval para limpeza posterior
    if (SESSIONS.has(sessionName)) {
      SESSIONS.get(sessionName).statusInterval = statusCheckInterval;
    }

    if (email) {
      try {
        await criarOuIgnorarUsuario(email);
        console.log(`✅ Usuário '${email}' garantido no banco (restauração).`);
      } catch (dbErr) {
        console.error(`❌ Erro ao garantir usuário (restauração):`, dbErr);
      }
    }

    client.onStateChange(async (state) => {
      console.log(`Estado restaurado da sessão ${sessionName}: ${state}`);
      
      try {
        // Atualiza status imediatamente quando há mudança de estado
        await atualizarStatusSessao(sessionName, state);
        console.log(`🔄 [${sessionName}] status atualizado via onStateChange: ${state}`);

        // Atualiza informações da sessão
        const session = SESSIONS.get(sessionName);
        if (session) {
          session.lastStateChange = Date.now();
          if (state === 'CONNECTED') {
            session.consecutiveFailures = 0;
            session.isHealthy = true;
          } else if (['DISCONNECTED', 'CLOSE', 'UNPAIRED', 'CONFLICT'].includes(state)) {
            session.isHealthy = false;
          }
        }
        
        if (state === 'CONNECTED') {
          try {
            const myNumber = await client.getWid();
            const session = SESSIONS.get(sessionName);
            if (session) {
              session.myNumber = myNumber;
              console.log(`Número restaurado (via onStateChange) para ${sessionName}: ${myNumber}`);
            }
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
          
          // Limpa o interval antes de fazer cleanup
          const session = SESSIONS.get(sessionName);
          if (session?.statusInterval) {
            clearInterval(session.statusInterval);
          }
          
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
        // ===== DEBUG GERAL PARA TODAS AS MENSAGENS =====
        console.log(`🔍 [MESSAGE-DEBUG] Mensagem recebida - Tipo: ${message.type}`);
        console.log(`🔍 [MESSAGE-DEBUG] From: ${message.from}, To: ${message.to}`);
        
        const filters = await loadFiltersFromDB(email, sessionName);
        SESSION_FILTERS.set(sessionName, filters);

        if (filters.ignoreGroups && message.isGroupMsg) return;
        if (filters.blockedNumbers && filters.blockedNumbers.includes(message.from)) return;

        const session = SESSIONS.get(sessionName);
        if (!session.myNumber) {
          try {
            const wid = await client.getWid();
            if (wid) {
              session.myNumber = wid;
              console.log(`🔁 Número definido dinamicamente via onAnyMessage para ${sessionName}: ${wid}`);
            }
          } catch (e) {
            console.warn(`[onAnyMessage] Falha ao obter myNumber dinâmico para ${sessionName}:`, e.message);
          }
        }

        if (!SESSIONS.get(sessionName)?.myNumber) {
          console.warn(`[onAnyMessage] Ainda sem myNumber para ${sessionName} após tentativa dinâmica.`);
          return;
        }

        if (message.type === 'ptt' || message.type === 'audio') {
          if (message.to === MAIN_BOT_NUMBER) {
            const receivingSession = SESSIONS.get(sessionName);
            if (receivingSession && receivingSession.myNumber === message.to) {
              console.log('🤖 Áudio direcionado ao bot detectado (sessão correta)');
              await processBotAudio(sessionName, message);
            } else {
              console.log('🔄 Áudio para bot detectado, mas processado por outra sessão - ignorando duplicata');
            }
          } else {
            console.log('📱 Áudio normal detectado - processando transcrição');
            enqueueProcessing(sessionName, () => processAudio(sessionName, message));
          }
        }

    if (message.type === 'ciphertext') {
      console.log(`🔐 [DECRYPT] Mensagem ciphertext detectada de ${message.from} — aguardando descriptografia...`);
      const decrypted = await waitForDecryptedMessage(client, message);
      if (!decrypted) {
        console.log(`🗑️ [DECRYPT] Mensagem descartada (não descriptografada): ${message.id}`);
        return; // ignora se não conseguiu
      }
      message = decrypted; // substitui pela versão completa
    }

    // ===== IMAGENS - NOVA LÓGICA PRIORITÁRIA =====
if (message.type === 'image' || message.type === 'IMAGE') {
  console.log(`🔍 [IMAGE-DEBUG] ✅ IMAGEM DETECTADA!`);
  console.log(`🔍 [IMAGE-DEBUG] To: ${message.to}`);
  console.log(`🔍 [IMAGE-DEBUG] From: ${message.from}`);
  console.log(`🔍 [IMAGE-DEBUG] MAIN_BOT_NUMBER: ${MAIN_BOT_NUMBER}`);

  // Verificar se é direcionada ao bot
  if (message.to === MAIN_BOT_NUMBER) {
    console.log(`🔍 [IMAGE-DEBUG] 🤖 Imagem É para o bot!`);
    
    // Verificar se é a sessão correta
    const receivingSession = SESSIONS.get(sessionName);
    if (receivingSession && receivingSession.myNumber === message.to) {
      console.log('🤖 [IMAGE-DEBUG] Imagem direcionada ao bot detectada (sessão correta)');

      const convoKey = `${session.myNumber}:${message.from}`;
      const stored = CONVERSATIONS.get(convoKey);

      console.log(`🔍 [IMAGE-DEBUG] ConvoKey: ${convoKey}`);
      console.log(`🔍 [IMAGE-DEBUG] Stored conversation:`, stored ? {
        activeTrigger: stored.activeTrigger,
        historyLength: stored.history?.length
      } : 'null');

      // ✅ Se há conversa ativa do tbvbusinesscard, mantém o fluxo atual
      if (stored && stored.activeTrigger === 'tbvbusinesscard') {
        console.log('📷 [IMAGE-DEBUG] ✅ Imagem detectada em conversa tbvbusinesscard ativa');
        console.log('📷 [IMAGE-DEBUG] 🚀 Chamando handleTriggerBusinessCard...');
        await handleTriggerBusinessCard(session, message, '', sessionName, email);
        return;
      }

      // ✅ Caso contrário, usa o novo analisador de imagens (processImage)
      console.log('🖼️ [IMAGE-DEBUG] 🚀 Sem conversa tbvbusinesscard ativa — chamando processImage...');
      await processImage(sessionName, message, email);
      return;

    } else {
      console.log('🔄 [IMAGE-DEBUG] Imagem para bot detectada, mas processada por outra sessão - ignorando duplicata');
      return;
    }
  } else {
    // Imagem normal (não direcionada ao bot) — preserva comportamento atual
    console.log('📱 [IMAGE-DEBUG] Imagem NÃO é para o bot - processando como texto normal');
    await processText(sessionName, message, email);
    return;
  }
}

        // ===== PROCESSAMENTO DE DOCUMENTOS PDF =====
        if (message.type === 'document' || message.type === 'DOCUMENT') {
          console.log(`🔍 [MESSAGE-DEBUG] ✅ DOCUMENTO DETECTADO!`);
          console.log(`🔍 [MESSAGE-DEBUG] Filename: ${message.filename}`);
          console.log(`🔍 [MESSAGE-DEBUG] MimeType: ${message.mimetype}`);
          console.log(`🔍 [MESSAGE-DEBUG] Size: ${message.size}`);
          console.log(`🔍 [MESSAGE-DEBUG] To: ${message.to}`);
          console.log(`🔍 [MESSAGE-DEBUG] From: ${message.from}`);
          console.log(`🔍 [MESSAGE-DEBUG] MAIN_BOT_NUMBER: ${MAIN_BOT_NUMBER}`);

          // Verificação: Se documento é direcionado ao BOT
          if (message.to === MAIN_BOT_NUMBER) {
            console.log(`🔍 [MESSAGE-DEBUG] 🤖 Documento É para o bot!`);
            
            // Documento direcionado ao bot - verificar se é a sessão correta
            const receivingSession = SESSIONS.get(sessionName);
            if (receivingSession && receivingSession.myNumber === message.to) {
              console.log('🤖 [MESSAGE-DEBUG] Documento direcionado ao bot detectado (sessão correta)');
              
              const convoKey = `${session.myNumber}:${message.from}`;
              const stored = CONVERSATIONS.get(convoKey);
              
              console.log(`🔍 [MESSAGE-DEBUG] ConvoKey: ${convoKey}`);
              console.log(`🔍 [MESSAGE-DEBUG] Stored conversation:`, stored ? {
                activeTrigger: stored.activeTrigger,
                historyLength: stored.history?.length
              } : 'null');
              
              // Só processar PDF se há conversa ativa do tbvvalidation
              if (stored && stored.activeTrigger === 'tbvvalidation') {
                console.log('📄 [MESSAGE-DEBUG] ✅ Documento PDF detectado em conversa tbvvalidation ativa');
                console.log('📄 [MESSAGE-DEBUG] 🚀 Chamando processPdfDocument...');
                enqueueProcessing(sessionName, () => processPdfDocument(sessionName, message, email));
              } else {
                console.log(`📄 [MESSAGE-DEBUG] ❌ Documento para bot ignorado. Motivo:`);
                console.log(`📄 [MESSAGE-DEBUG] - Stored exists: ${!!stored}`);
                console.log(`📄 [MESSAGE-DEBUG] - Active trigger: ${stored?.activeTrigger || 'none'}`);
                console.log(`📄 [MESSAGE-DEBUG] - Expected: tbvvalidation`);
                
                // Enviar mensagem explicativa se não há conversa ativa
                await client.sendText(message.from, 
                  '📄 Para analisar documentos, primeiro ative o assistente enviando "TBV Anti Malandro" ou uma mensagem sobre análise de contratos.'
                );
              }
            } else {
              console.log('🔄 [MESSAGE-DEBUG] Documento para bot detectado, mas processado por outra sessão - ignorando duplicata');
            }
          } else {
            // Documento normal (não direcionado ao bot)
            console.log('📱 [MESSAGE-DEBUG] Documento NÃO é para o bot - processando como texto normal');
            await processText(sessionName, message, email);
          }
        }

      } catch (error) {
        console.error(`❌ [MESSAGE-DEBUG] Erro ao processar mensagem na sessão ${sessionName}:`, error);
        console.error(`❌ [MESSAGE-DEBUG] Stack trace:`, error.stack);
      }
    });

    console.log(`✅ Sessão ${sessionName} restaurada com sucesso`);
    return client;

  } catch (error) {
    console.error(`⚠️ Erro ao restaurar sessão ${sessionName}:`, error);
    throw error;
  }
};

// ✅ AGORA restoreSessions pode chamar restoreSession normalmente
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
    
    // 4. Iniciar o processamento do primeiro lote
    await processNextBatch();
    
  } catch (err) {
    console.error('❌ Erro ao consultar sessões no banco:', err);
  }
};

// ✅ Inicialização do servidor
restoreSessions().then(() => {
  const port = process.env.PORT;
  server.listen(port, () => {
    console.log(`🚀 Servidor rodando na porta ${port}`);
  });
});
