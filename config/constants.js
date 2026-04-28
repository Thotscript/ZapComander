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
  '--mute-audio'
];

export const myTokenStore = new wppconnect.tokenStore.FileTokenStore({ path: TOKEN_DIR });
