import db from './index.js';

export async function saveSessionLog({ email, numero, ultimo_acesso }) {
    const sql = `
        INSERT INTO logs_sessao (email, sessao_numero, ultimo_acesso)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
            sessao_numero = VALUES(sessao_numero),
            ultimo_acesso = VALUES(ultimo_acesso)
    `;
    await db.query(sql, [email, numero, ultimo_acesso]);
}
