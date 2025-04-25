// db/sessions.js
import db from './index.js';

export async function criarOuIgnorarSessao(numero, email, profile_name) {
  const sql = `
    INSERT INTO sessoes (numero, usuario_email)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE numero = numero
  `;
  await db.query(sql, [numero, email, profile_name]);
}
