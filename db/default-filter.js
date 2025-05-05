import db from './index.js';

export async function insertDefaultFilters(email, sessao_numero) {
    const filtrosPadrao = {
        language: 'pt-br',
        translation_enabled: 1,
        sendForward: 1,
        ignoreGroups: 1,
        summarizeMessages: 0,
        longmessage: 1
    };

    for (const [filtro_nome, valor] of Object.entries(filtrosPadrao)) {
        const sql = `
            INSERT INTO filtros (email, sessao_numero, filtro_nome, valor)
            SELECT ?, ?, ?, ?
            FROM DUAL
            WHERE NOT EXISTS (
                SELECT 1 FROM filtros
                WHERE email = ? AND sessao_numero = ? AND filtro_nome = ?
            )
        `;
        await db.query(sql, [
            email,
            sessao_numero,
            filtro_nome,
            valor,
            email,
            sessao_numero,
            filtro_nome
        ]);
    }
}
