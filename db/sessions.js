import db from './index.js';

export async function criarOuIgnorarSessao(numero, email) {
  const sql = `
    INSERT INTO sessoes (numero, usuario_email)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE numero = numero
  `;
  await db.query(sql, [numero, email]);
}

export async function atualizarStatusSessao(numero, status) {
  const sql = `
    UPDATE sessoes
    SET status = ?
    WHERE numero = ?
  `;
  await db.query(sql, [status, numero]);
}

export async function excluirSessaoPorEmail(email, sessionName) {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Remove filtros diretamente (opcional se ON DELETE CASCADE estiver configurado)
    await conn.query('DELETE FROM filtros WHERE sessao_numero = ?', [sessionName]);

    // 2. Remove a sessão específica (isso apagará logs_sessao via ON DELETE CASCADE)
    const [result] = await conn.query(
      'DELETE FROM sessoes WHERE usuario_email = ? AND numero = ?',
      [email, sessionName]
    );

    if (result.affectedRows === 0) {
      console.warn(`⚠️ Nenhuma sessão encontrada para exclusão: ${sessionName}`);
      await conn.commit(); // Ainda finaliza a transação para evitar bloqueios
      return;
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

