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
  try {
    await db.beginTransaction();

    // 1. Exclui filtros associados à sessão (chave estrangeira)
    await db.query('DELETE FROM filtros WHERE sessao_numero = ?', [sessionName]);

    // 2. Exclui logs relacionados ao email
    await db.query('DELETE FROM logs_sessao WHERE email = ?', [email]);

    // 3. Exclui a sessão
    await db.query('DELETE FROM sessoes WHERE usuario_email = ?', [email]);

    await db.commit();
  } catch (err) {
    await db.rollback();
    throw err;
  }
}
