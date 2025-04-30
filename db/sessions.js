// db/sessions.js
import db from './index.js';

export async function criarOuIgnorarSessao(numero, email) {
  const sql = `
    INSERT INTO sessoes (numero, usuario_email)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE numero = numero
  `;
  await db.query(sql, [numero, email]);
}

export async function excluirSessaoPorEmail(email) {
  // Remove da tabela sessoes e logs_sessao com base no email
  const deleteLogs = 'DELETE FROM logs_sessao WHERE email = ?';
  const deleteSessoes = 'DELETE FROM sessoes WHERE usuario_email = ?';

  await db.query(deleteLogs, [email]);
  await db.query(deleteSessoes, [email]);
}