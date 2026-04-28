import dotenv from 'dotenv';
dotenv.config();

import cors from 'cors';
import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import { TOKEN_DIR, SESSION_LOGS_DIR, QR_CODES_DIR, AUDIO_DIR } from './config/constants.js';
import { initWss, setupWebSocket } from './ws/websocket.js';
import { restoreSessions } from './services/session.js';
import authRouter from './routes/auth.js';
import devicesRouter from './routes/devices.js';
import messagesRouter from './routes/messages.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === 'production';

[SESSION_LOGS_DIR, QR_CODES_DIR, AUDIO_DIR, TOKEN_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();

let server;
if (isProduction) {
  const { default: httpsOptions } = await import('./config/https.js');
  server = https.createServer(httpsOptions, app);
} else {
  server = http.createServer(app);
  console.log('⚠️  Modo desenvolvimento — servidor HTTP sem TLS');
}

initWss(server);

const errorLogPath = isProduction
  ? '/var/log/wpptalk-errors.log'
  : path.join(__dirname, 'errors.log');
const logStream = fs.createWriteStream(errorLogPath, { flags: 'a' });
server.on('clientError', (err, socket) => {
  logStream.write(`${new Date().toISOString()} | IP: ${socket.remoteAddress || 'desconhecido'} | ${err.message}\n`);
  socket.destroy();
});

app.use(cors());
app.use(express.json());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", 'https://verbai.com.br:8443'],
      imgSrc:     ["'self'", 'data:', 'https://verbai.com.br:8443'],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://verbai.com.br:8443']
    }
  }
}));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || 'https://thebroker.vip');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use('/qrcodes', express.static(QR_CODES_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.use(authRouter);
app.use(devicesRouter);
app.use(messagesRouter);

setupWebSocket();

restoreSessions().then(() => {
  const port = process.env.PORT;
  server.listen(port, () => console.log(`🚀 Servidor rodando na porta ${port}`));
});