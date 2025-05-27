import db from './index.js';

export async function saveFiltersToDB(email, sessao_numero, filters) {
  // nothing to do if there are no filters
  const entries = Object.entries(filters);
  if (entries.length === 0) return;

  // build rows: [email, sessao_numero, filtro_nome, valor]
  const rows = entries.map(([filtro_nome, valor]) => {
    const valorNormalized = typeof valor === 'boolean'
      ? (valor ? 1 : 0)
      : valor;
    return [ email, sessao_numero, filtro_nome, valorNormalized ];
  });

  // bulk upsert
  const sql = `
    INSERT INTO filtros (email, sessao_numero, filtro_nome, valor)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      valor = VALUES(valor)
  `;

  try {
    await db.query(sql, [rows]);
  } catch (err) {
    console.error('saveFiltersToDB error:', err);
    throw err;
  }
}
