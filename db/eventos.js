import db from './index.js';

export async function saveEventoToDB(numero, eventoInfo) {
  try {
    await db.query(
      `INSERT INTO lembretes (numero, titulo, data, hora, local, observacoes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        numero,
        eventoInfo.titulo || '',
        eventoInfo.data || '',
        eventoInfo.hora || '',
        eventoInfo.local || '',
        eventoInfo.observacoes || ''
      ]
    );
  } catch (err) {
    console.error('❌ Erro ao salvar evento no banco:', err.message);
  }
}
