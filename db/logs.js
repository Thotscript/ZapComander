import db from './index.js';
import { DateTime } from 'luxon';

const DDI_TO_TIMEZONE = {
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

function extractPhoneNumberInfo(sender) {
  const raw = sender.split('@')[0].replace(/[^\d]/g, '');
  for (const len of [3, 2, 1]) {
    const code = raw.slice(0, len);
    if (DDI_TO_TIMEZONE[code]) return { ddi: code, timezone: DDI_TO_TIMEZONE[code] };
  }
  return { ddi: null, timezone: null };
}

export async function saveSessionLog({ email, sessaoNumero, whatsappNumero, duracao = 0 }) {
  const { timezone } = extractPhoneNumberInfo(whatsappNumero);
  const ultimoAcessoLocal = timezone
    ? DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd HH:mm:ss')
    : DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss');

  const duracaoInt = Math.max(0, Math.round(duracao));

  const sql = `
    INSERT INTO logs_sessao (email, sessao_numero, ultimo_acesso, duracao_segundos, total_transcricoes)
    VALUES (?, ?, ?, ?, 1)
    ON DUPLICATE KEY UPDATE
      ultimo_acesso      = VALUES(ultimo_acesso),
      duracao_segundos   = duracao_segundos + VALUES(duracao_segundos),
      total_transcricoes = total_transcricoes + 1
  `;
  await db.query(sql, [email, sessaoNumero, ultimoAcessoLocal, duracaoInt]);
}
