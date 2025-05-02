import db from './index.js';

export async function insertDefaultFilters(email, sessao_numero) {
    const sql = `
        INSERT INTO filtros (
            email,
            sessao_numero,
            language,
            translation_enabled,
            sendForward,
            ignoreGroups,
            summarizeMessages,
            longmessage
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            language = VALUES(language),
            translation_enabled = VALUES(translation_enabled),
            sendForward = VALUES(sendForward),
            ignoreGroups = VALUES(ignoreGroups),
            summarizeMessages = VALUES(summarizeMessages),
            longmessage = VALUES(longmessage)
    `;

    const valores = [
        email,
        sessao_numero,
        'pt-br',
        1, // translation_enabled
        1, // sendForward
        1, // ignoreGroups
        0, // summarizeMessages
        1  // longmessage
    ];

    await db.query(sql, valores);
}
