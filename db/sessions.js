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
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Remove filtros vinculados à sessão (via sessionName)
    await conn.query('DELETE FROM filtros WHERE sessao_numero = ?', [sessionName]);

    // 2. Remove logs vinculados ao email (relação FK está em logs_sessao.email -> sessoes.usuario_email)
    await conn.query('DELETE FROM logs_sessao WHERE email = ?', [email]);

    // 3. Remove a sessão específica (email + sessionName)
    await conn.query(
      'DELETE FROM sessoes WHERE usuario_email = ? AND numero = ?',
      [email, sessionName]
    );

    await conn.commit();
    console.log(`✅ Sessão ${sessionName} e dados relacionados excluídos com sucesso.`);
  } catch (err) {
    await conn.rollback();
    console.error('❌ Erro ao excluir sessão e dados relacionados:', err);
    throw err;
  } finally {
    conn.release();
  }
}

