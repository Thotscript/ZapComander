import path from 'path';
import { fileURLToPath } from 'url';
import wppconnect from '@wppconnect-team/wppconnect';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export const TOKEN_DIR = process.env.NODE_ENV === 'production'
  ? '/root/wpptalk_server/tokens'
  : path.join(__dirname, '..', 'tokens');

export const SESSION_LOGS_DIR = path.join(TOKEN_DIR, 'sessions_logs');
export const QR_CODES_DIR     = path.join(__dirname, '..', 'public', 'qrcodes');
export const TEMP_DIR         = path.join(__dirname, '..', 'temp');
export const AUDIO_DIR        = path.join(__dirname, '..', 'audios');

export const DDI_TO_TIMEZONE = {
  '1':   'America/New_York',
  '44':  'Europe/London',
  '33':  'Europe/Paris',
  '49':  'Europe/Berlin',
  '34':  'Europe/Madrid',
  '39':  'Europe/Rome',
  '55':  'America/Sao_Paulo',
  '351': 'Europe/Lisbon',
  '54':  'America/Argentina/Buenos_Aires',
  '81':  'Asia/Tokyo',
  '91':  'Asia/Kolkata',
  '61':  'Australia/Sydney',
  '86':  'Asia/Shanghai'
};

export const PUPPETEER_ARGS = [
  '--mute-audio',

  // Necessário quando roda como root
  '--no-sandbox',
  '--disable-setuid-sandbox',

  // Reduz uso de memória/compartilhamento em VPS/Docker
  '--disable-dev-shm-usage',

  // Desabilita recursos gráficos desnecessários
  '--disable-gpu',
  '--disable-software-rasterizer',

  // Desabilita extensões e serviços em segundo plano
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-client-side-phishing-detection',
  '--safebrowsing-disable-auto-update',

  // Reduz processos/recursos automáticos
  '--no-first-run',
  '--no-default-browser-check',
  '--metrics-recording-only',
  '--disable-popup-blocking',
  '--disable-notifications',

  // Reduz recursos visuais
  '--hide-scrollbars',
  '--disable-infobars',

  // Desabilita features que consomem recursos
  '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',

  // Útil em servidores sem interface gráfica
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows'
];

export const myTokenStore = new wppconnect.tokenStore.FileTokenStore({ path: TOKEN_DIR });
