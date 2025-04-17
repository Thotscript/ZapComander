import db from './index.js';

export async function criarOuIgnorarUsuario(email, plano = 'free', limite = 0) {
    const sql = `
        INSERT INTO usuarios (email, plano, limite_minutos_mensal)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE email=email
    `;
    await db.query(sql, [email, plano, limite]);
}
