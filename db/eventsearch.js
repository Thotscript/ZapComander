import db from './index.js';
import { DateTime } from 'luxon';

async function checkEvents(numero) {
  // 1️⃣ Obter agora e daqui a 5 minutos em strings compatíveis com o banco
  const now    = DateTime.local();                   // seu servidor em America/Sao_Paulo
  const later5 = now.plus({ minutes: 5 });

  const nowDate    = now.toISODate();                // "YYYY-MM-DD"
  const nowTime    = now.toFormat('HH:mm');          // "HH:mm"
  const laterDate  = later5.toISODate();             // pode alterar dia no fim do mês
  const laterTime  = later5.toFormat('HH:mm');       // "HH:mm"

  // 2️⃣ Montar e executar a query
  const sql = `
    SELECT
      id,
      numero,
      titulo,
      \`data\`,
      hora,
      local,
      observacoes
    FROM sua_tabela
    WHERE numero = ?
      AND (
        ( \`data\` = ? AND hora = ? )
        OR
        ( \`data\` = ? AND hora = ? )
      );
  `;

  try {
    const [rows] = await db.query(sql, [
      numero,
      nowDate, nowTime,
      laterDate, laterTime
    ]);

    // 3️⃣ Disparar console.log para cada evento encontrado
    for (const ev of rows) {
      const whenLabel = (ev.data === nowDate && ev.hora === nowTime)
        ? 'AGORA'
        : 'EM 5 MIN';
      console.log(
        `[${whenLabel}] Evento "${ev.titulo}" (${ev.id}) ` +
        `em ${ev.local} — ${ev.data} ${ev.hora}`
      );
    }
  } catch (err) {
    console.error('❌ Erro ao checar eventos:', err.message);
  }
}

// 4️⃣ Agendar a verificação a cada 1 minuto
const numeroDoCliente = '+5511999998888';
checkEvents(numeroDoCliente);                // primeira chamada imediata
setInterval(
  () => checkEvents(numeroDoCliente),
  60 * 1000                                // 60 000 ms = 1 min
);
