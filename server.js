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
import { pool } from './db/index.js';
import { criarOuIgnorarUsuario } from './db/usuarios.js';
import { criarOuIgnorarSessao } from './db/sessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/fullchain.pem')
};

const server = https.createServer(options, app);
const wss = new WebSocket.Server({ server });
const myTokenStore = new wppconnect.tokenStore.FileTokenStore({ path: './tokens' });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PROMPT_PRE_QUALIFICACAO = process.env.PROMPT_PRE_QUALIFICACAO;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const PORT = process.env.PORT;

const SESSIONS = new Map();

// caminhos absolutos centralizados
const TOKEN_DIR        = '/root/wpptalk/tokens';
const FILTERS_FILE     = path.join(TOKEN_DIR, 'filters', 'filters.json');
const SESSIONS_FILE    = path.join(TOKEN_DIR, 'sessions.json');
const SESSION_LOGS_DIR = path.join(TOKEN_DIR, 'sessions_logs');

const QR_CODES_DIR = path.join(__dirname, 'public', 'qrcodes');
const AUDIO_DIR    = path.join(__dirname, 'audios');

// para disparar o bot e guardar o histórico por conversa
const TRIGGER_KEYWORDS = ["@bot"];
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

export function saveSessionEmail(sessionName, email) {
  let data = {};
  if (fs.existsSync(SESSIONS_FILE)) {
    data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  }
  data[sessionName] = email;
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function loadAllSessionEmails() {
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
}

function loadFiltersFromFile() {
  if (fs.existsSync(FILTERS_FILE)) {
    const raw = fs.readFileSync(FILTERS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const sessionName in data) {
      SESSION_FILTERS.set(sessionName, data[sessionName]);
    }
    console.log('Filtros carregados do arquivo.');
  }
}

function saveFiltersToFile() {
  const filtersObj = Object.fromEntries(SESSION_FILTERS);
  fs.writeFileSync(FILTERS_FILE, JSON.stringify(filtersObj, null, 2), 'utf8');
  console.log('Filtros salvos no arquivo.');
}

loadFiltersFromFile();

// ===== Rotas e lógica de sessão =====

app.get('/auth/statusfinder', (req, res) => {
  const email = req.body.email || req.query.email;
  if (!email) {
    return res.status(400).json({ error: 'Email é obrigatório.' });
  }

  const sessionEntry = [...SESSIONS.entries()].find(
    ([, sessionObj]) => sessionObj.email === email
  );
  if (!sessionEntry) {
    return res.status(404).json({ error: 'Sessão ativa não encontrada para este email.' });
  }
  const [sessionName] = sessionEntry;

  const logFilePath = path.join(SESSION_LOGS_DIR, `${sessionName}.json`);
  if (!fs.existsSync(logFilePath)) {
    return res.status(404).json({ error: 'Arquivo de log não encontrado. Nenhuma mensagem de áudio processada ainda.' });
  }

  try {
    const raw = fs.readFileSync(logFilePath, 'utf8');
    const logData = JSON.parse(raw);
    return res.json({ sessionName, log: logData });
  } catch (err) {
    console.error(`❌ Erro ao ler log de ${sessionName}:`, err);
    return res.status(500).json({ error: 'Falha ao ler o arquivo de log.' });
  }
});

app.get('/auth/logout', async (req, res) => {
  const session = req.query.sessionName;
  if (!session) {
    return res.status(400).json({ error: 'Session é obrigatório.' });
  }
  try {
    await cleanupSession(session);
    res.status(200).json({ message: 'Sessão finalizada com sucesso.' });
  } catch {
    res.status(500).json({ error: 'Erro ao finalizar sessão.' });
  }
});

app.get('/auth/:sessionName', async (req, res) => {
  const { sessionName } = req.params;
  const { email = null } = req.query;

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
          saveSessionEmail(sessionName, email);
          console.log('Token salvo com sucesso!');

          const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
          if (fs.existsSync(qrFilePath)) {
            setTimeout(() => {
              fs.unlink(qrFilePath, () => {
                console.log(`Sessão ${sessionName} autenticada, QR Code removido!`);
              });
            }, 10000);
          }
        }
      } catch (error) {
        console.error(`⚠️ Erro no onStateChange da sessão ${sessionName}:`, error);
      }
    });

    client.onAnyMessage(async (message) => {
      try {
        const filters = SESSION_FILTERS.get(sessionName) || {};
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


// 3) Função para salvar/atualizar filtros no MySQL:
async function saveFiltersToDB(sessaoNumero, filters) {
  const conn = await pool.getConnection();
  try {
    // a) Limpa os filtros antigos desta sessão
    await conn.execute(
      'DELETE FROM filtros WHERE sessao_numero = ?',
      [sessaoNumero]
    );

    // b) Prepara as linhas para inserção
    const rows = Object.entries(filters).map(([nome, valor]) => [
      sessaoNumero,
      nome,
      // serializa valor (boolean, array, string, número…)
      typeof valor === 'string'   ? valor
      : typeof valor === 'boolean' ? (valor ? '1' : '0')
      : JSON.stringify(valor)
    ]);

    if (rows.length > 0) {
      // c) Bulk-insert
      await conn.query(
        'INSERT INTO filtros (sessao_numero, filtro_nome, valor) VALUES ?',
        [rows]
      );
    }
  } finally {
    conn.release();
  }
}


//ROTA FILTROS

app.post('/auth/filtro', async (req, res) => {
    const {
      email,
      ignoreGroups,
      blockedNumbers,
      summaryzemessages,
      longmessage
    } = req.body;
  
    if (!email) {
      return res.status(400).json({ message: 'Email é obrigatório.' });
    }
  
    // Buscar a sessão correspondente ao e-mail
    const sessionEntry = [...SESSIONS.entries()].find(([_, value]) => value.email === email);
  
    if (!sessionEntry) {
      return res.status(404).json({ message: 'Sessão com este e-mail não encontrada.' });
    }
  
    const [sessionName] = sessionEntry;
    const currentFilters = SESSION_FILTERS.get(sessionName) || {};
  
    const updatedFilters = {
      ...currentFilters,
      ...(ignoreGroups !== undefined && { ignoreGroups: !!ignoreGroups }),
      ...(summaryzemessages !== undefined && { summaryzemessages: !!summaryzemessages }),
      ...(longmessage !== undefined && { longmessage }),
      ...(blockedNumbers !== undefined ? {
        blockedNumbers: Array.from(new Set([
          ...(Array.isArray(currentFilters.blockedNumbers) ? currentFilters.blockedNumbers : []),
          ...(Array.isArray(blockedNumbers) ? blockedNumbers : [blockedNumbers])
        ]))
      } : {})
      
    };
  
    SESSION_FILTERS.set(sessionName, updatedFilters);
    saveFiltersToFile();

    try {
      await saveFiltersToDB(sessionName, updatedFilters);
    } catch (err) {
      console.error('Erro ao salvar filtros no MySQL:', err);
      // você pode optar por não falhar a rota inteira, ou retornar 500:
      return res.status(500).json({ message: 'Não foi possível salvar filtros no banco.' });
    }
  
    res.json({ message: `Filtros atualizados para a sessão com user: ${email}` });
  });

  //CARREGA OS FILTROS

  async function loadFilters() {
    const filtersPath = '/wpptalk/tokens/filters/filters.json';
    const data = fs.readFileSync(filtersPath, 'utf-8'); // Lê o conteúdo do arquivo
    return JSON.parse(data); // Parseia o JSON para um objeto JavaScript
}

 //CARREGA A SESSAO

async function loadSessions() {
    const sessionsPath = '/wpptalk/tokens/sessions_logs/sessions.json';
    const data = fs.readFileSync(sessionsPath, 'utf-8');
    return JSON.parse(data);
}

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


//LIMPAR PASTAS DE SESSAO

async function cleanupSession(sessionName) {

    if (SESSIONS.has(sessionName)) {
        const session = SESSIONS.get(sessionName);
        await session.client.logout();
        await session.client.close();
        SESSIONS.delete(sessionName);
        console.log(`🔴 Sessão ${sessionName} encerrada.`);
    }

    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
    if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath);

    const sessionPath = path.join(TOKEN_DIR, sessionName);
    setTimeout(() => {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`Sessão:[${sessionName}] => Removida por falha na autenticação!`);
        }
    }, 3000);
}

//WEBSOCKET PARA ENVIAR O QRCODE PARA O FRONT

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'requestQR') {
                broadcastQR(data.sessionName);
            }
        } catch (error) {
            console.error('❌ Erro ao processar mensagem WebSocket:', error);
        }
    });

    ws.on('close', () => console.log('❌ Cliente desconectado do WebSocket'));
});

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


//SALVAR LOG DE AUDIO NO MYSQL

async function saveSessionLog({ email, numero, ultimo_acesso }) {
  const conn = await pool.getConnection();
  try {
    const sql = `
      INSERT INTO logs_sessao (email, numero, ultimo_acesso)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
        numero = VALUES(numero),
        ultimo_acesso = VALUES(ultimo_acesso)
    `;
    await conn.execute(sql, [email, numero, ultimo_acesso]);
  } finally {
    conn.release();
  }
}


//PROCESSAR AUDIO RECEBIDO

async function processAudio(sessionName, message) {
    try {
        if (!SESSIONS.has(sessionName)) throw new Error(`Sessão ${sessionName} não encontrada.`);

        const session = SESSIONS.get(sessionName);
        const client = session.client;
        const myNumber = session.myNumber;

        if (!myNumber) {
            console.error(`⚠️ Número da sessão ${sessionName} ainda não definido.`);
            return;
        }

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

        // **Definição da variável transcricao antes de usá-la**
        const transcricao = response.data.text;

        // Chamada para resumir a transcrição no GPT-4o-mini
        const response_gpt = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: `
                                - Você é um agente de IA que recebe transcrições de audios e os resume em tópicos.
                                - Você deve sempre fornecer a tradução em caso de mensagens em inglês.
                                - Você deve resumir mantendo o contexto e semântica da mensagem recebida, respondendo como se fosse o proprio remetente da mensagem.
                                - Você deve primeiro enviar o resumo do audio e em seguida os tópicos e no final você deve adicionar "Transcribed by Thebroker.vip"`
                    },
                    {
                        role: "user",
                        content: `Resuma a seguinte transcrição de áudio: "${transcricao}"`
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
        await client.sendText(myNumber, resumo, {
            quotedMsg:message.id
        });

        fs.unlinkSync(inputPath);

        const now = new Date();
        const day   = now.getDate().toString().padStart(2, '0');
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const year  = now.getFullYear().toString();
        const hours   = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const formattedDateTime = `${day}/${month}/${year} - ${hours}:${minutes}`;
    
        const logData = {
          email: session.email,
          numero: session.myNumber,
          ultimo_acesso: formattedDateTime
        };

        try {
          await saveSessionLog(logData);
          res.json({ message: 'Log de sessão gravado.' });
        } catch (err) {
          console.error(err);
          res.status(500).json({ message: 'Erro ao gravar log de sessão.' });
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

//PROCESSAR TEXTO RECEBIDO - BOT

async function processText(sessionName, message) {
    try {
        const session = SESSIONS.get(sessionName);
        if (!session) throw new Error(`Sessão ${sessionName} não encontrada.`);
        
        const { client, myNumber } = session;
        if (!myNumber) {
            console.log('[processText] Número da sessão não definido. Abortando.');
            return;
        }

        // Ignora mensagens do próprio bot para evitar loop
        if (message.from === myNumber) {
            return;
        }

        const text = message.body?.trim();
        if (!text) {
            return;
        }

        console.log(`[processText] Mensagem recebida de ${message.from}: "${text}"`);

        const lowerText = text.toLowerCase();
        const convoKey = `${sessionName}:${message.from}`; // Usa message.from como identificador do chat
        const containsTrigger = TRIGGER_KEYWORDS.some(kw => lowerText.includes(kw));
        const hasHistory = CONVERSATIONS.has(convoKey);

        if (!containsTrigger && !hasHistory) {
            return;
        }

        // Inicializa histórico se necessário
        if (!CONVERSATIONS.has(convoKey)) {
            CONVERSATIONS.set(convoKey, [
                { 
                    role: "system", 
                    content: `Início e Contextualização:

Apresente-se como assistente de pré-qualificação para financiamentos imobiliários e explique que a conversa reunirá as informações necessárias.

Informe que, ao final, será gerada uma tabela com os dados para que o cliente possa copiá-la.

Divisão das Seções e Perguntas a Serem Feitas:

Direcionamento:
1 - Não faca perguntas desnecessárias, como por exemplo o estado civil do cônjuge, se ele é cônjuge ja sabemos o estado civil
2 - Não pergunte algo que você ja sabe, apenas peça confirmação
3 - Faca UMA pergunta de cada vez, mesmo perguntas que estao em uma mesma seção
4 - Seja sempre amigável

Seção 1 – Informações Pessoais:

Pergunte:

Qual é o seu nome e sobrenome?

Qual é o seu e-mail?

Qual é o seu telefone?

Qual é a sua data de nascimento?

Qual é o seu estado civil?

Qual é a sua nacionalidade (cidadania)?

Você possui visto americano? (Sim/Não)

Seção 2 – Informações do Cônjuge (será aplicado caso o cliente tiver estado civil = Casado):

Se o cliente informar ser casado, pergunte:

Qual é o nome e sobrenome do seu cônjuge?

Qual é o e-mail do seu cônjuge?

Qual é o telefone do seu cônjuge?

Qual é o estado civil do seu cônjuge?

O seu cônjuge possui visto americano? (Sim/Não)

Seção 3 – Endereço Residencial:

Pergunte:

Qual é o seu endereço completo (rua, número, bairro e, se houver, complemento)?

Em qual país você reside?

Em qual estado?

Qual é o CEP?

Seu imóvel é próprio, alugado ou financiado?

Se for financiado, pergunte: Qual o valor do financiamento?

Se for alugado, pergunte: Qual o valor anual do aluguel?

Qual o valor anual do seguro residencial (se aplicável)?

Seção 4 – Outros Imóveis:

Pergunte:

Você possui outro imóvel? (Sim/Não)

Se sim, pergunte:
a. Esse outro imóvel está alugado? (Sim/Não)
b. Esse outro imóvel está financiado? (Sim/Não)
c. Qual é o endereço do outro imóvel?
d. Qual é o valor do aluguel (se alugado)?
e. Qual é o valor do financiamento (se financiado)?

Seção 5 – Informações de Emprego:

Pergunte:

Qual é o nome do seu empregador atual?

Em qual ramo de atividade a empresa atua?

Qual é o tipo do seu contrato de trabalho (CLT, PJ, Autônomo, Empresário)?

Seção 6 – Salário Bruto do Titular:

Pergunte:

Qual o valor acumulado do seu salário bruto em 2024?

Qual o valor acumulado em 2023?

Qual o valor acumulado em 2022?

Qual é a sua profissão?

Qual é o seu cargo atual?

Há quantos anos você está neste emprego?

Seção 7 – Bônus Anual:

Pergunte:

Qual o valor do seu bônus anual em 2024?

Qual o valor do seu bônus em 2023?

Qual o valor do seu bônus em 2022?

Seção 8 – Informações da Sua Empresa (se aplicável):

Pergunte:

Qual é o nome da sua empresa?

Qual é a área de atuação da empresa?

Seção 9 – Faturamento Anual da Empresa:

Pergunte:

Qual o faturamento anual acumulado em 2024?

Qual o faturamento acumulado em 2023?

Qual o faturamento acumulado em 2022?

Em que ano sua empresa foi criada?

Seção 10 – Renda Anual Recebida da Empresa:

Pergunte:

Qual o valor da renda anual que você recebe da sua empresa em 2024?

E em 2023?

E em 2022?

Seção 11 – Informações de Emprego do Cônjuge (se aplicável):

Pergunte:

Qual é o nome do empregador do seu cônjuge?

Em qual ramo de atividade ele atua?

Qual o tipo de contrato de trabalho do seu cônjuge (CLT, PJ, Autônomo, Empresário)?

Seção 12 – Salário Bruto do Cônjuge (se aplicável):

Pergunte:

Qual o valor acumulado do salário bruto do seu cônjuge em 2024?

Em 2023?

Em 2022?

Qual é a profissão do seu cônjuge?

Qual é o cargo atual dele(a)?

Há quantos anos ele(a) está neste emprego?

Seção 13 – Investimentos:

Pergunte:

Qual o valor acumulado dos seus investimentos em 2024?

Em 2023?

Em 2022?

Você possui investimentos fora do Brasil? (Sim/Não)

Se sim, pergunte:
a. Qual o tipo de investimento?
b. Qual o valor acumulado total desses investimentos?
c. Em qual moeda estão esses investimentos?

Seção 14 – Informações Bancárias:

Pergunte:

Qual é o saldo total em todas as suas contas pessoais?

Qual é o saldo total em todas as contas da sua empresa?

Você possui conta bancária nos EUA? (Sim/Não)

Se sim, pergunte:
a. Qual o nome do seu banco principal?
b. Qual é o banco da sua empresa?

Seção 15 – Empréstimos e Financiamentos:

Pergunte:

Qual o valor total dos seus empréstimos e financiamentos?

Qual o valor das parcelas?

Quais são os empréstimos/financiamentos (por exemplo, carro, moto, maquinário, etc.)?

Qual o saldo devedor atual?

Caso possua mais de um, solicite que liste cada um com os mesmos detalhes.

Seção 16 – Imóvel nos EUA:

Pergunte:

Você possui imóvel nos EUA? (Sim/Não)

Se sim, pergunte:
a. Qual o endereço do imóvel?
b. Qual o valor da hipoteca?
c. Qual o valor em dólar, se aplicável?

Seção 17 – Dados do Imóvel a ser Financiado:

Pergunte:

Qual é o preço de venda do imóvel (em dólares, se for o caso)?

Qual é o valor da entrada?

Qual é o endereço do imóvel que deseja financiar?

Qual a utilização prevista para o imóvel?

Apresente as opções:

Segunda casa somente para uso privado.

Segunda casa para uso privado ou curtas temporadas de aluguel (renda para cobrir despesas).

Propriedade de investimento destinada à locação majoritária.

Confirmação dos Dados:

Após cada pergunta ou seção, confirme o dado informado, por exemplo:
"Anotado: [Campo] – [Resposta]."

Permita que o cliente revise e, se necessário, corrija qualquer informação antes de prosseguir para a próxima seção.

Geração do Resumo em Tabela:

Ao término de todas as seções, compile todos os dados coletados em uma tabela estruturada com duas colunas:

Coluna 1: Nome do Campo

Coluna 2: Resposta do Cliente

Exiba a tabela final na conversa, utilizando um formato simples (por exemplo, Markdown ou texto tabular), como no exemplo a seguir:

less
Copy
| Campo                          | Resposta                      |
|--------------------------------|-------------------------------|
| Nome Completo                  | [Resposta do Cliente]         |
| E-mail                         | [Resposta do Cliente]         |
| Telefone                       | [Resposta do Cliente]         |
| Data de Nascimento             | [Resposta do Cliente]         |
| Estado Civil                   | [Resposta do Cliente]         |
| Nacionalidade                  | [Resposta do Cliente]         |
| Visto Americano                | [Resposta do Cliente]         |
| Endereço Residencial           | [Resposta do Cliente]         |
| ...                            | ...                           |
Instrua o cliente a copiar a tabela e utilizar os dados conforme necessário.

Finalização:

Pergunte se todas as informações estão corretas e se o cliente deseja revisar ou alterar algum dado antes da finalização.

Agradeça a participação e reforce que os dados foram compilados com sucesso.`.trim()
        }
    ]);
}

const history = CONVERSATIONS.get(convoKey);
history.push({ role: "user", content: text });

const resp = await openai.chat.completions.create({
    model: ASSISTANT_MODEL,
    messages: history,
    temperature: 0.7
});

const reply = resp.choices[0].message.content.trim();

history.push({ role: "assistant", content: reply });
await client.sendText(message.from, reply); // Usa message.from para resposta

} catch (err) {
console.error(`❌ Erro crítico em processText: ${err.message}`, err.stack);
}
}


//RESTAURAR SESSOES EM CASO DE QUEDA DO SERVIDOR

const restoreSessions = async () => {
  const sessions = fs.readdirSync(TOKEN_DIR);

  for (const sessionName of sessions) {
    try {
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

      // Carrega e atribui e‑mail salvo
      const sessionEmails = loadAllSessionEmails();
      const email = sessionEmails[sessionName] || null;
      SESSIONS.get(sessionName).email = email;

      // --- Novo: garante que o usuário existe no banco ---
      if (email) {
        try {
          await criarOuIgnorarUsuario(email);
          console.log(`✅ Usuário '${email}' garantido no banco (restauração).`);
        } catch (dbErr) {
          console.error(`❌ Erro ao garantir usuário (restauração):`, dbErr);
        }
      }

      // Função auxiliar de retry para obter myNumber
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

          // --- Novo: persiste a sessão no banco ao conectar ---
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
          const filters = SESSION_FILTERS.get(sessionName) || {};
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
  

//INICIA A FUNCAO DE RESTAURAR SESSOES JUNTO COM O START DO SERVIDOR
restoreSessions().then(() => {
    const port = process.env.PORT;
    server.listen(port, () => {
        console.log(`🚀 Servidor rodando na porta ${port}`);
    });
});