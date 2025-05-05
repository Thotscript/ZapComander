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

    // 1. Remove filtros diretamente (opcional se você já tem ON DELETE CASCADE em filtros.sessao_numero)
    await conn.query('DELETE FROM filtros WHERE sessao_numero = ?', [sessionName]);

    // 2. Não é mais necessário deletar logs_sessao manualmente

    // 3. Remove a sessão específica (isso apagará logs_sessao via ON DELETE CASCADE)
    const [result] = await conn.query(
      'DELETE FROM sessoes WHERE usuario_email = ? AND numero = ?',
      [email, sessionName]
    );

    if (result.affectedRows === 0) {
      throw new Error(`Nenhuma sessão encontrada para exclusão: ${sessionName}`);
    }

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
