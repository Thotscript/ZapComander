require('dotenv').config({path:'./chave.env'});
const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const EU = '5511994297562@c.us'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const PORT = process.env.PORT || 3000;
const SESSIONS = new Map();
const QR_CODES_DIR = path.join(__dirname, 'public', 'qrcodes');
if (!fs.existsSync(QR_CODES_DIR)) {
    fs.mkdirSync(QR_CODES_DIR, { recursive: true });
}

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

        const sessionPath = path.join(__dirname, 'tokens', sessionName);
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const client = await wppconnect.create({
            session: sessionName,
            catchQR: (base64Qr) => {
                saveQRCode(base64Qr, sessionName);

                // **Definir timeout para encerrar sessão se não for escaneado**
                setTimeout(() => {
                  if (SESSIONS.has(sessionName)) {
                      const client = SESSIONS.get(sessionName);
                      client.getConnectionState().then(state => {
                          if (state !== 'CONNECTED') {
                              console.log(`⏳ QR Code da sessão ${sessionName} expirou. Encerrando sessão.`);
                              cleanupSession(sessionName);
                          }
                      });
                  }
              }, 30000);
              
            },
            headless: true,
            autoClose: false,
            qrTimeout: 0,
            puppeteerOptions: {
                userDataDir: sessionPath,
            }
        });

        SESSIONS.set(sessionName, client);

        client.onStateChange((state) => {
          console.log(`📡 Estado da sessão ${sessionName}: ${state}`);
          if (state === 'CONNECTED') {
              console.log(`✅ Sessão ${sessionName} autenticada com sucesso.`);
              broadcastSessionAuthenticated(sessionName);
      
              // Evita apagar a sessão se já foi autenticada
              if (SESSIONS.has(sessionName)) {
                  clearTimeout(SESSIONS.get(sessionName).timeoutId);
              }
          }
      });

        client.onMessage(async (message) => {
            if (message.type === 'ptt' || message.mimetype?.startsWith('audio/')) {
                console.log('🔊 Mensagem de áudio recebida. Processando...');
                await processAudio(client, message, sessionName);
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

function cleanupSession(sessionName) {
  console.log(`🗑️ Limpando sessão ${sessionName}...`);
  
  // Remover QR Code
  const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
  if (fs.existsSync(qrFilePath)) {
      fs.unlinkSync(qrFilePath);
      console.log(`🗑️ QR Code da sessão ${sessionName} removido.`);
  }

  // Remover pasta da sessão
  const sessionPath = path.join(__dirname, 'tokens', sessionName);
  if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`🗑️ Pasta da sessão ${sessionName} removida.`);
  }

  // Remover sessão do mapa
  if (SESSIONS.has(sessionName)) {
      SESSIONS.delete(sessionName);
      console.log(`🔴 Sessão ${sessionName} encerrada.`);
  }
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

async function processAudio(client, message, sessionName) {
    try {
        const session = SESSIONS.get(sessionName);
        if (!session) throw new Error(`Sessão ${sessionName} não encontrada.`);

        const contact = await client.getContact(message.from);
        const senderName = contact?.pushname || contact?.name || message.from;

        console.log(`🔊 Processando áudio de ${senderName} na sessão ${sessionName}...`);

        const audioPath = path.join(__dirname, 'audios');
        if (!fs.existsSync(audioPath)) fs.mkdirSync(audioPath);

        const inputPath = path.join(audioPath, `${message.id}.ogg`);
        const buffer = await client.decryptFile(message);
        fs.writeFileSync(inputPath, buffer);

        const formData = new FormData();
        formData.append('file', fs.createReadStream(inputPath));
        formData.append('model', 'whisper-1');

        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            }
        });
        const transcricao = response.data.text;
        console.log(`✅ Transcrição concluída para ${senderName}: ${transcricao}`);

        await session.sendText(EU, `🎤 Transcrição do áudio de ${senderName}: ${transcricao}`);

    } catch (error) {
        console.error('❌ Erro ao processar áudio:', error?.response?.data || error.message);
        await client.sendText(message.from, 'Erro ao transcrever o áudio. ❌');
    }
}

server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
