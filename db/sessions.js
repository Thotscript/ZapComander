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

    // 1. Exclui filtros relacionados à sessão
    await conn.query('DELETE FROM filtros WHERE sessao_numero = ?', [sessionName]);

    // 2. Exclui logs relacionados à sessão (filtrando pelo número)
    await conn.query('DELETE FROM logs_sessao WHERE email = ? AND sessao_numero = ?', [email, sessionName]);

    // 3. Exclui a sessão específica do usuário
    await conn.query('DELETE FROM sessoes WHERE usuario_email = ? AND numero = ?', [email, sessionName]);

    await conn.commit();
    console.log(`✅ Sessão ${sessionName} removida com sucesso para o usuário ${email}.`);
  } catch (err) {
    await conn.rollback();
    console.error('❌ Erro ao excluir sessão e dados relacionados:', err);
    throw err;
  } finally {
    conn.release();
  }
}
