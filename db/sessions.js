import db from './index.js';

export async function criarOuIgnorarUsuario(email) {
  const sql = `
    INSERT INTO usuarios (email)
    VALUES (?)
    ON DUPLICATE KEY UPDATE email = email
  `;
  await db.query(sql, [email]);
}