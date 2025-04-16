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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/verbai.com.br/fullchain.pem')
};
const FILTERS_FILE = './tokens/filters/filters.json';
const server = https.createServer(options,app);
const wss = new WebSocket.Server({ server });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PROMPT_PRE_QUALIFICACAO = process.env.PROMPT_PRE_QUALIFICACAO;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const PORT = process.env.PORT;
const SESSIONS = new Map();
const QR_CODES_DIR = path.join(__dirname, 'public', 'qrcodes');
const AUDIO_DIR = path.join(__dirname, 'audios');
const TOKEN_DIR = path.join(__dirname, 'tokens');

// para disparar o bot e guardar o histórico por conversa
const TRIGGER_KEYWORDS = ["@bot"];
const CONVERSATIONS = new Map();
const ASSISTANT_MODEL = "gpt-4o-mini";

// Objeto para armazenar filtros em memória
const SESSION_FILTERS = new Map();
const SESSIONS_FILE = path.join(__dirname, 'tokens', 'sessions.json');
const SESSION_LOGS_DIR = path.join(__dirname, 'tokens', 'sessions_logs');

if (!fs.existsSync(SESSION_LOGS_DIR)) {
  fs.mkdirSync(SESSION_LOGS_DIR, { recursive: true });
}

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
  const filtersObj = {};
  for (const [sessionName, filters] of SESSION_FILTERS.entries()) {
    filtersObj[sessionName] = filters;
  }
  fs.writeFileSync(FILTERS_FILE, JSON.stringify(filtersObj, null, 2), 'utf8');
  console.log('Filtros salvos no arquivo.');
}

loadFiltersFromFile();

[QR_CODES_DIR, AUDIO_DIR, TOKEN_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use(cors());
app.use(express.json());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "https://verbai.com.br:8443"],
      imgSrc: ["'self'", "data:", "https://verbai.com.br:8443"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://verbai.com.br:8443"]
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

const myTokenStore = new wppconnect.tokenStore.FileTokenStore({ path: './tokens' });

app.use(express.json()); // Certifique-se de que isso esteja no topo para parsear JSON

app.get('/auth/statusfinder', (req, res) => {
    // Você pode receber pelo body ou pela query
    const email = req.body.email || req.query.email;
    if (!email) {
      return res.status(400).json({ error: 'Email é obrigatório.' });
    }
  
    // 1) Encontra a sessão ativa com esse email
    const sessionEntry = [...SESSIONS.entries()].find(
      ([, sessionObj]) => sessionObj.email === email
    );
    if (!sessionEntry) {
      return res.status(404).json({ error: 'Sessão ativa não encontrada para este email.' });
    }
    const [sessionName] = sessionEntry;
  
    // 2) Monta o caminho do arquivo de log
    const logFilePath = path.join(SESSION_LOGS_DIR, `${sessionName}.json`);
  
    // 3) Verifica se o arquivo existe
    if (!fs.existsSync(logFilePath)) {
      return res
        .status(404)
        .json({ error: 'Arquivo de log não encontrado. Nenhuma mensagem de áudio processada ainda.' });
    }
  
    // 4) Lê e retorna o conteúdo
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
    const email = req.query.email;
    if (!email) {
        return res.status(400).json({ error: 'Email é obrigatório.' });
    }

    const sessionEntry = [...SESSIONS.entries()].find(
        ([, sessionObj]) => sessionObj.email === email
    );
    if (!sessionEntry) {
        return res.status(404).json({ error: 'Sessão não encontrada para este email.' });
    }

    const [sessionName, sessionClient] = sessionEntry;

    try {
        await logoutSession(sessionName, sessionClient);  // Usando a função de logout já com o método de limpeza
        return res.json({ success: true, message: 'Sessão encerrada com sucesso.' });
    } catch (error) {
        console.error(`Erro ao encerrar sessão ${sessionName}:`, error);
        return res.status(500).json({ error: 'Erro ao encerrar a sessão.' });
    }
});



async function logoutSession(sessionName, sessionClient) {
    // Chamando o logout no client
    await sessionClient.logout();  // Método de logout no cliente
    console.log(`🔴 Sessão ${sessionName} deslogada com sucesso.`);
    
    // Fechando o navegador ou headless
    await sessionClient.close();  // Fechando o navegador
    console.log(`Sessão ${sessionName} encerrada e navegador fechado.`);
    
    // Remover a sessão do mapa
    SESSIONS.delete(sessionName);
    console.log(`Sessão ${sessionName} removida do mapa.`);
  
    // Remover o QR code
    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
    if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath);

    // Remover os arquivos de sessão
    const sessionPath = path.join(TOKEN_DIR, sessionName);
    setTimeout(() => {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`Sessão:[${sessionName}] => Removida após logout.`);
        }
    }, 3000);
}






app.get('/auth/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const { email = null } = req.query; // Captura o e-mail do corpo

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
            statusFind: (statusSession, sessionName) => {
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

        // Salva a sessão incluindo o e-mail
        SESSIONS.set(sessionName, {
            client,
            myNumber: null,
            email: email || null
        });

        client.onStateChange(async (state) => {
            try {
                console.log(`Estado da sessão ${sessionName}: ${state}`);
                if (state === 'CONNECTED') {
                    console.log(`✅ Sessão ${sessionName} autenticada.`);
                    broadcastSessionAuthenticated(sessionName);

                    const myNumber = await client.getWid();
                    const session = SESSIONS.get(sessionName);
                    session.myNumber = myNumber;

                    console.log(`Número Logado para ${sessionName}: ${myNumber}`);
                    console.log(`E-mail associado: ${session.email}`);

                    const sessionToken = await client.getSessionTokenBrowser();
                    await myTokenStore.setToken(sessionName, sessionToken);
                    saveSessionEmail(sessionName, email);
                    console.log('Token salvo com sucesso!');

                    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
                    if (fs.existsSync(qrFilePath)) {
                        setTimeout(() => {
                            fs.unlink(qrFilePath, (err) => {
                                if (!err) {
                                    console.log(`Sessão ${sessionName} autenticada, QR Code removido!`);
                                }
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
                    console.log(`Mensagem de áudio recebida na sessão ${sessionName}. Processando...`);
                    await processAudio(sessionName, message);
                }

                console.log(message.type);

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


app.post('/auth/filtro', (req, res) => {
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
  
    res.json({ message: `Filtros atualizados para a sessão com user: ${email}` });
  });

  async function loadFilters() {
    const filtersPath = path.join(__dirname, 'tokens', 'filters', 'filters.json');
    const data = fs.readFileSync(filtersPath, 'utf-8'); // Lê o conteúdo do arquivo
    return JSON.parse(data); // Parseia o JSON para um objeto JavaScript
}

async function loadSessions() {
    const sessionsPath = path.join(__dirname, 'tokens', 'sessions.json');
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



app.delete('/delete-session/:sessionName', (req, res) => {
    const { sessionName } = req.params;

    if (!SESSIONS.has(sessionName)) {
        return res.status(404).json({ message: `Sessão ${sessionName} não encontrada.` });
    }
    cleanupSession(sessionName);
});

async function cleanupSession(sessionName) {

    if (SESSIONS.has(sessionName)) {
        const session = SESSIONS.get(sessionName);
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

wss.on('connection', (ws) => {;
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
                    content: `${PROMPT_PRE_QUALIFICACAO}`.trim()
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
  
        // Carrega email salvo
        const sessionEmails = loadAllSessionEmails();
        const email = sessionEmails[sessionName] || null;
        SESSIONS.get(sessionName).email = email;
  
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
            // aguarda antes da próxima tentativa
            await new Promise((r) => setTimeout(r, delayMs));
          }
          console.error(`❌ Não foi possível restaurar myNumber para ${sessionName} após várias tentativas.`);
        };
  
        // Inicia o retry (não bloqueia a execução)
        fetchMyNumberWithRetry();
  
        // Também atualiza no onStateChange, caso a sessão se reconecte
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
  


restoreSessions().then(() => {
    const port = process.env.PORT;
    server.listen(port, () => {
        console.log(`🚀 Servidor rodando na porta ${port}`);
    });
});