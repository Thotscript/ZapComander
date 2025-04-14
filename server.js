import dotenv from 'dotenv';
dotenv.config();
import cors from 'cors';
import wppconnect from '@wppconnect-team/wppconnect';
import express from 'express';
import http from 'http';
import fs from 'fs';
import WebSocket from 'ws';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import helmet from 'helmet';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const FILTERS_FILE = './tokens/filters/filters.json'
const server = http.createServer(app);
const wss = new WebSocket.Server({ server }); 
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT
const SESSIONS = new Map();
const QR_CODES_DIR = path.join(__dirname, 'public', 'qrcodes');
const AUDIO_DIR = path.join(__dirname, 'audios');
const TOKEN_DIR = path.join(__dirname, 'tokens');

// Objeto para armazenar filtros em memória
const SESSION_FILTERS = new Map();
const SESSIONS_FILE = path.join(__dirname, 'tokens', 'sessions.json');


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
// Carregar filtros do arquivo JSON ao iniciar
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

// Salvar filtros no arquivo
function saveFiltersToFile() {
    const filtersObj = {};
    for (const [sessionName, filters] of SESSION_FILTERS.entries()) {
        filtersObj[sessionName] = filters;
    }
    fs.writeFileSync(FILTERS_FILE, JSON.stringify(filtersObj, null, 2), 'utf8');
    console.log('Filtros salvos no arquivo.');
}

// Carregar ao iniciar
loadFiltersFromFile();

// Criar diretórios necessários caso não existam
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
            defaultSrc: ["'self'", "http://jrssolutions.com.br"],
            imgSrc: ["'self'", "data:", "http://jrssolutions.com.br"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "http://jrssolutions.com.br"]
        }
    }
}));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'https://thebroker.vip');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  
    // Adicionando o header necessário:
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
});

app.use('/qrcodes', express.static(QR_CODES_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const myTokenStore = new wppconnect.tokenStore.FileTokenStore({
    path: './tokens',
});

app.use(express.json()); // Certifique-se de que isso esteja no topo para parsear JSON

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
                const qrCodeURL = `http://jrssolutions.com.br/qrcodes/${path.basename(qrFilePath)}`;
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
            puppeteerOptions: { userDataDir: sessionPath }
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

        client.onMessage(async (message) => {
            try {
                const filters = SESSION_FILTERS.get(sessionName) || {};

                if (filters.ignoreGroups && message.isGroupMsg) return;
                if (filters.blockedNumbers && filters.blockedNumbers.includes(message.from)) return;

                if (message.type === 'ptt' || message.type === 'audio') {
                    console.log(`Mensagem de áudio recebida na sessão ${sessionName}. Processando...`);
                    await processAudio(sessionName, message);
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

    } catch (error) {
        console.error('❌ Erro ao processar áudio:', error?.response?.data || error.message);
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
                },
            });

            const sessionEmails = loadAllSessionEmails();
            const email = sessionEmails[sessionName] || null;

            SESSIONS.set(sessionName, { client, myNumber: null, email});

            client.onStateChange(async (state) => {
                console.log(`Estado restaurado da sessão ${sessionName}: ${state}`);
                if (state === 'CONNECTED') {
                    const myNumber = await client.getWid();
                    SESSIONS.get(sessionName).myNumber = myNumber;
                    console.log(`Número restaurado para ${sessionName}: ${myNumber}`);
                }
            });

            client.onMessage(async (message) => {
                try {

                    const filters = SESSION_FILTERS.get(sessionName) || {}; 

                    if (filters.ignoreGroups && message.isGroupMsg) return;
                    if (filters.blockedNumbers && filters.blockedNumbers.includes(message.from)) return;

                    if (message.type === 'ptt' || message.type === 'audio') {
                        console.log(`Mensagem de áudio recebida na sessão ${sessionName}. Processando...`);
                        await processAudio(sessionName, message);
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
    const port = process.env.PORT || 3001;
    server.listen(port, () => {
        console.log(`🚀 Servidor rodando na porta ${port}`);
    });
});