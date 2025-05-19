import { DateTime } from 'luxon'; // <-- com chaves

// ... o resto do seu código permanece igual
const DDI_TO_TIMEZONE = {
  '1': 'America/New_York',
  '44': 'Europe/London',
  '33': 'Europe/Paris',
  '49': 'Europe/Berlin',
  '34': 'Europe/Madrid',
  '39': 'Europe/Rome',
  '55': 'America/Sao_Paulo',
  '351': 'Europe/Lisbon',
  '54': 'America/Argentina/Buenos_Aires',
  '81': 'Asia/Tokyo',
  '91': 'Asia/Kolkata',
  '61': 'Australia/Sydney',
  '86': 'Asia/Shanghai'
};

/**
 * Extrai o DDI de uma string (ex: "+55", "0055", "55...") e retorna o timezone correspondente
 * @param {string} input - Texto contendo o número com DDI
 * @returns {{ddi: string|null, timezone: string|null, horarioLocal: string|null}}
 */
function getTimezoneFromString(input) {
  // Normaliza o número, removendo espaços e caracteres não numéricos
  const clean = input.replace(/[^\d]/g, '');

  // Tenta extrair os 3, depois 2, depois 1 dígito iniciais como DDI
  let ddi = null;
  for (let len of [3, 2, 1]) {
    const code = clean.slice(0, len);
    if (DDI_TO_TIMEZONE[code]) {
      ddi = code;
      break;
    }
  }

  if (!ddi) {
    return {
      ddi: null,
      timezone: null,
      horarioLocal: null
    };
  }

  const timezone = DDI_TO_TIMEZONE[ddi];
  const now = DateTime.now().setZone(timezone);

  return {
    ddi,
    timezone,
    horarioLocal: now.toFormat('yyyy-MM-dd HH:mm:ss')
  };
}

// Exemplo de uso:
const resultado = getTimezoneFromString('+55 11 91234-5678');
console.log(resultado);
