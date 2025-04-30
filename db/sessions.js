import db from './index.js';

export async function criarOuIgnorarSessao(numero, email) {
  const sql = `
    INSERT INTO sessoes (numero, usuario_email)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE numero = numero
  `;
  await db.query(sql, [numero, email]);
}

export async function excluirSessaoPorEmail(email, sessionName) {
  const conn = await db.getConnection(); // pega conexão individual do pool

  try {
    await conn.beginTransaction();

    // 1. Exclui filtros relacionados ao sessionName
    await conn.query('DELETE FROM filtros WHERE sessao_numero = ?', [sessionName]);

    // 2. Exclui logs relacionados ao email
    await conn.query('DELETE FROM logs_sessao WHERE email = ?', [email]);

    // 3. Exclui a sessão relacionada ao email
    await conn.query('DELETE FROM sessoes WHERE usuario_email = ?', [email]);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release(); // libera conexão de volta para o pool
  }
}
