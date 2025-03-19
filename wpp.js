const wppconnect = require('@wppconnect-team/wppconnect');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;
const SESSIONS = new Map();

// Servir arquivos estáticos da pasta public
app.use('/qrcodes', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// Criar sessão do WhatsApp
app.get('/auth/:sessionName', async (req, res) => {
  const { sessionName } = req.params;
  res.sendFile(path.join(__dirname, 'public', 'index.html'));

  if (SESSIONS.has(sessionName)) {
    return res.json({ message: `Sessão ${sessionName} já autenticada.` });
  }

  try {
    const client = await wppconnect.create({
      session: sessionName,
      catchQR: (base64Qr) => {
        let matches = base64Qr.match(/^data:image\/png;base64,(.+)$/);
        if (!matches) {
          console.error('Formato de QR Code inválido.');
          return;
        }

        let imageBuffer = Buffer.from(matches[1], 'base64');
        const qrFilePath = path.join(__dirname, 'public', `qrcode_${sessionName}.png`);

        fs.writeFile(qrFilePath, imageBuffer, (err) => {
          if (err) {
            console.error('Erro ao salvar o QR Code:', err);
          } else {
            console.log(`📸 QR Code salvo em ${qrFilePath}`);
            broadcastQR(sessionName);
          }
        });
      },
      headless: true,
      autoClose: false,
      qrTimeout: 0,
    });

    SESSIONS.set(sessionName, { client });

    client.on('authenticated', () => {
      console.log(`✅ Sessão ${sessionName} autenticada!`);
      SESSIONS.set(sessionName, { client });
    });

    client.on('disconnected', () => {
      console.log(`❌ Sessão ${sessionName} desconectada!`);
      SESSIONS.delete(sessionName);
    });
  } catch (error) {
    console.error(`Erro ao criar sessão ${sessionName}:`, error);
    res.status(500).json({ error: `Erro ao criar sessão ${sessionName}` });
  }
});

// WebSocket para envio de QR Code
wss.on('connection', (ws) => {
  console.log('📡 Cliente conectado ao WebSocket');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'requestQR') {
        broadcastQR(data.sessionName);
      }
    } catch (error) {
      console.error('Erro ao processar mensagem WebSocket:', error);
    }
  });

  ws.on('close', () => {
    console.log('❌ Cliente desconectado do WebSocket');
  });
});

// Função para enviar QR Code via WebSocket
function broadcastQR(sessionName) {
  const qrPath = `/qrcodes/qrcode_${sessionName}.png?t=${Date.now()}`; // Cache-buster
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'qr', sessionName, qrPath }));
    }
  });
}

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
