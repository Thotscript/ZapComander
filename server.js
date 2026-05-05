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
import { TOKEN_DIR, SESSION_LOGS_DIR, QR_CODES_DIR, AUDIO_DIR, TEMP_DIR } from './config/constants.js';
import { initWss, setupWebSocket } from './ws/websocket.js';
import { restoreSessions } from './services/session.js';
import authRouter from './routes/auth.js';
import devicesRouter from './routes/devices.js';
import messagesRouter from './routes/messages.js';
import agentsRouter from './routes/agents.js';
import usuariosRouter from './routes/usuarios.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === 'production';
// USE_HTTPS=false desativa TLS no Node quando ele roda atrás de um proxy (ex: Apache/Nginx)
const useHttps = isProduction && process.env.USE_HTTPS !== 'false';

[SESSION_LOGS_DIR, QR_CODES_DIR, AUDIO_DIR, TOKEN_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();

let server;
if (useHttps) {
  const { default: httpsOptions } = await import('./config/https.js');
  server = https.createServer(httpsOptions, app);
  console.log('🔒 Servidor HTTPS (TLS direto)');
} else {
  server = http.createServer(app);
  console.log(isProduction
    ? '🔁 Servidor HTTP — TLS delegado ao proxy reverso'
    : '⚠️  Modo desenvolvimento — servidor HTTP sem TLS'
  );
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

const PROD_ORIGINS = [
  'https://thebroker.vip',
  'https://zapbot.botcomander.com.br',
  ...(process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : [])
];

app.use(cors({
  origin: (origin, cb) => {
    // sem origin = curl / same-origin / requisições internas → ok
    if (!origin) return cb(null, true);
    // qualquer localhost em dev → ok
    if (!isProduction && /^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    // origens de produção → ok
    if (PROD_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(helmet({
  contentSecurityPolicy: isProduction ? {
    directives: {
      defaultSrc: ["'self'", 'https://zapbot.botcomander.com.br'],
      imgSrc:     ["'self'", 'data:', 'https://zapbot.botcomander.com.br'],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://zapbot.botcomander.com.br'],
      connectSrc: ["'self'", 'wss://zapbot.botcomander.com.br']
    }
  } : false
}));
app.use('/qrcodes', express.static(QR_CODES_DIR));
app.use('/temp', express.static(TEMP_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login', 'index.html'));
});

app.get('/painel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'painel', 'index.html'));
});

app.use(authRouter);
app.use(devicesRouter);
app.use(messagesRouter);
app.use(agentsRouter);
app.use(usuariosRouter);

setupWebSocket();

restoreSessions().then(() => {
  const port = process.env.PORT;
  server.listen(port, () => console.log(`🚀 Servidor rodando na porta ${port}`));
});