import db from './index.js';

export async function saveEventoToDB(email, sessionName, eventoInfo) {
  try {
    await db.query(
      `INSERT INTO lembretes (email, session_name, titulo, data, hora, local, observacoes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        email,
        sessionName,
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
