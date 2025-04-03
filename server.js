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

// Definir __dirname corretamente para ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT
const SESSIONS = new Map();
const QR_CODES_DIR = path.join(__dirname, 'public', 'qrcodes');
const AUDIO_DIR = path.join(__dirname, 'audios');
const TOKEN_DIR = path.join(__dirname, 'tokens');

// Criar diretórios necessários caso não existam
[QR_CODES_DIR, AUDIO_DIR, TOKEN_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});


app.use(cors());

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
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"); // Permite qualquer origem
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp"); // Para permitir uso em iframes e imagens
    res.setHeader("Access-Control-Allow-Origin", "*"); // Libera acesso de qualquer domínio
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    next();
});

app.use('/qrcodes', express.static(QR_CODES_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/auth/:sessionName', async (req, res) => {
    const { sessionName } = req.params;

    // Se a sessão já estiver autenticada, responda imediatamente.
    if (SESSIONS.has(sessionName)) {
        return res.json({ message: `Sessão ${sessionName} já autenticada.` });
    }

    try {
        console.log(`Criando sessão: ${sessionName}`);
        const sessionPath = path.join(TOKEN_DIR, sessionName);
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        let responseSent = false; // Flag para garantir envio único da resposta

        const client = await wppconnect.create({
            session: sessionName,
            statusFind: (statusSession, sessionName) => {
                if (statusSession === 'autocloseCalled') {
                    cleanupSession(sessionName);
                }
            },
            deviceName: 'The Broker VIP',
            catchQR: async (base64Qr) => {
                const qrFilePath = await saveQRCode(base64Qr, sessionName);
                const qrCodeURL = `http://jrssolutions.com.br/qrcodes/${path.basename(qrFilePath)}`;
                // Envia a resposta apenas uma vez.
                if (!responseSent) {
                    responseSent = true;
                    res.json({ qrCodeFile: qrCodeURL });
                }
                // Também notifica via WebSocket para o(s) cliente(s) conectado(s).
                broadcastQR(sessionName);
            },
            disableWelcome: false,
            debug: true, // Opens a debug session
            logQR: false, // Logs QR automatically in terminal
            updatesLog: true,
            headless: true,
            autoClose: 45000,
            puppeteerOptions: { userDataDir: sessionPath }
        });

        // Armazena a sessão ativa.
        SESSIONS.set(sessionName, { client, myNumber: null });

        client.onStateChange(async (state) => {
            try {
                console.log(`Estado da sessão ${sessionName}: ${state}`);
                if (state === 'CONNECTED') {
                    console.log(`✅ Sessão ${sessionName} autenticada.`);
                    broadcastSessionAuthenticated(sessionName);

                    const myNumber = await client.getWid();
                    SESSIONS.get(sessionName).myNumber = myNumber;
                    console.log(`Número Logado para ${sessionName}: ${myNumber}`);

                    // Em vez de remover imediatamente, podemos aguardar alguns segundos
                    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
                    if (fs.existsSync(qrFilePath)) {
                        setTimeout(() => {
                            fs.unlink(qrFilePath, (err) => {
                                if (!err) {
                                    console.log(`Sessão ${sessionName} autenticada, QR Code removido!`);
                                }
                            });
                        }, 10000); // Remove após 10 segundos
                    }
                }
            } catch (error) {
                console.error(`⚠️ Erro no onStateChange da sessão ${sessionName}:`, error);
            }
        });

        client.onMessage(async (message) => {
            try {
                if (message.type === 'ptt' || message.type === 'audio') {
                    console.log(`Mensagem de áudio recebida na sessão ${sessionName}. Processando...`);
                    await processAudio(sessionName, message);
                }
            } catch (error) {
                console.error(`Erro ao processar mensagem na sessão ${sessionName}:`, error);
            }
        });

    } catch (error) {
        console.error(`Erro ao criar sessão [${sessionName}]:`, error);
        return res.status(500).json({ message: `Erro ao criar sessão: ${error.message}` });
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
                        content: "Você é um agente que recebe transcrições de audio e resume as mensagens sempre que ultrapassarem 200 caracteres, seu resumo de conter tópicos principais, ao final do resumo adicione a url: https://thebroker.vip"
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
        const legenda = `*Transcrição do áudio de ${senderName}:* \n\n${transcricao}\n\n📌 *Resumo:* \n${resumo}`;
        await new Promise(resolve => setTimeout(resolve, 10));
        await client.sendText(myNumber, legenda);

    } catch (error) {
        console.error('❌ Erro ao processar áudio:', error?.response?.data || error.message);
    }
}


server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
