import db from './index.js';
import { DateTime } from 'luxon';

// Copiado diretamente do seu server.js
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

/**
 * Extrai DDI e timezone de uma string "5511999999999@c.us"
 * (mesma lógica do seu server.js)
 */
function extractPhoneNumberInfo(sender) {
  const raw   = sender.split('@')[0].replace(/[^\d]/g, '');
  let ddi     = null;
  let timezone= null;

  for (let len of [3, 2, 1]) {
    const code = raw.slice(0, len);
    if (DDI_TO_TIMEZONE[code]) {
      ddi      = code;
      timezone = DDI_TO_TIMEZONE[code];
      break;
    }
  }

  return { ddi, timezone };
}

/**
 * Salva o log usando o horário **já convertido** para o fuso do usuário.
 * Parâmetros:
 *   - email: string
 *   - numero: string (ex: "5511999999999@c.us")
 */
export async function saveSessionLog({ email, numero }) {
  const { timezone } = extractPhoneNumberInfo(numero);

  // formata "YYYY-MM-DD HH:mm:ss" no fuso local ou UTC se não identificado
  const ultimoAcessoLocal = timezone
    ? DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd HH:mm:ss')
    : DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss');

  const sql = `
    INSERT INTO logs_sessao (email, sessao_numero, ultimo_acesso)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      sessao_numero = VALUES(sessao_numero),
      ultimo_acesso = VALUES(ultimo_acesso)
  `;

  await db.query(sql, [email, numero, ultimoAcessoLocal]);
}
