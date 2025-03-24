import dotenv from 'dotenv';
dotenv.config();
import wppconnect from '@wppconnect-team/wppconnect';
import express from 'express';
import http from 'http';
import fs from 'fs';
import WebSocket from 'ws';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { fileURLToPath } from 'url';

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

app.use('/qrcodes', express.static(QR_CODES_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/auth/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    res.sendFile(path.join(__dirname, 'public', 'index.html'));

    if (SESSIONS.has(sessionName)) {
        return res.json({ message: `Sessão ${sessionName} já autenticada.` });
    }

    try {
        console.log(`🟡 Criando sessão: ${sessionName}`);

        const sessionPath = path.join(TOKEN_DIR, sessionName);
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        // Adicionando um timeout para garantir que o `create()` não trave
        const client = await Promise.race([
            wppconnect.create({
                session: sessionName,
                deviceName: 'The Broker VIP',
                catchQR: (base64Qr) => saveQRCode(base64Qr, sessionName),
                headless: true,
                autoClose: 15000,
                qrTimeout: 15000,
                puppeteerOptions: { userDataDir: sessionPath }
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout na criação da sessão')), 20000)) // Timeout de 20 segundos
        ]);

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

                    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
                    if (fs.existsSync(qrFilePath)) {
                        fs.unlinkSync(qrFilePath);
                        console.log(`Sessão ${sessionName} autenticada, QR Code de autenticação removido!`);
                    }
                } 
                else if (state === 'TIMEOUT' || state === 'DISCONNECTED' || state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
                    console.log(`❌ Sessão ${sessionName} não foi conectada. Removendo dados...`);
                    await cleanupSession(sessionName);
                }
            } catch (error) {
                console.error(`⚠️ Erro no evento onStateChange da sessão ${sessionName}:`, error);
            }
        });

        client.onMessage(async (message) => {
            try {
                if (message.type === 'ptt' || message.mimetype?.startsWith('audio/')) {
                    console.log(`🔊 Mensagem de áudio recebida na sessão ${sessionName}. Processando...`);
                    const audioDuration = await client.message.size();
                    console.log(`Duração do audio: ${audioDuration}`);
                    await processAudio(sessionName, message);
                }
            } catch (error) {
                console.error(`⚠️ Erro ao processar mensagem na sessão ${sessionName}:`, error);
            }
        });

    } catch (error) {
        console.error('❌ Erro ao criar sessão:', error);
    }
});


function saveQRCode(base64Qr, sessionName) {
    const matches = base64Qr.match(/^data:image\/png;base64,(.+)$/);
    if (!matches) return console.error('Formato de QR Code inválido.');

    const imageBuffer = Buffer.from(matches[1], 'base64');
    const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);

    fs.writeFile(qrFilePath, imageBuffer, (err) => {
        if (err) {
            console.error('Erro ao salvar QR Code:', err);
        } else {
            console.log(`✅ QR Code salvo em: ${qrFilePath}`);
            broadcastQR(sessionName);
        }
    });
}

app.delete('/delete-session/:sessionName', (req, res) => {
    const { sessionName } = req.params;

    if (!SESSIONS.has(sessionName)) {
        return res.status(404).json({ message: `Sessão ${sessionName} não encontrada.` });
    }

    cleanupSession(sessionName);
    res.json({ message: `Sessão ${sessionName} encerrada e limpa.` });
});

async function cleanupSession(sessionName) {
    console.log(`🗑️ Limpando sessão ${sessionName}...`);

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
            console.log(`🗑️ Dados da sessão ${sessionName} foram removidos.`);
        }
    }, 3000);

    console.log(`🗑️ Dados da sessão ${sessionName} foram removidos.`);
}

wss.on('connection', (ws) => {
    console.log('📡 Cliente conectado ao WebSocket');

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
    console.log(`📡 Enviando QR Code para o frontend: ${qrPath}`);

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
        const senderName = contact?.pushname || contact?.name || message.from;

        console.log(`🔊 Processando áudio de ${senderName} na sessão ${sessionName}...`);

        const inputPath = path.join(AUDIO_DIR, `${message.id}.ogg`);
        const buffer = await client.decryptFile(message);
        fs.writeFileSync(inputPath, buffer);

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
                        content: "Você é um agente que recebe transcrições de audio e resume as mensagens sempre que ultrapassarem 200 caracteres, seu resumo de conter tópicos principais, você deve fornecer a transcrição original no final da mensagem"
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
