import db from './index.js';
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

async function hashSenha(senha) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(senha, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

async function verificarSenha(senha, stored) {
  const [salt, hash] = stored.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const derivedKey = await scryptAsync(senha, salt, 64);
  return timingSafeEqual(hashBuffer, derivedKey);
}

export async function criarOuIgnorarUsuario(email, plano = 'free', limite = 0) {
  const sql = `
    INSERT INTO usuarios (email, plano, limite_minutos_mensal)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE email = email
  `;
  await db.query(sql, [email, plano, limite]);
}

export async function registrarUsuario(email, senha) {
  const senhaHash = await hashSenha(senha);
  const sql = `
    INSERT INTO usuarios (email, plano, limite_minutos_mensal, senha_hash)
    VALUES (?, 'free', 0, ?)
    ON DUPLICATE KEY UPDATE senha_hash = VALUES(senha_hash)
  `;
  await db.query(sql, [email, senhaHash]);
}

export async function autenticarUsuario(email, senha) {
  const [rows] = await db.query(
    'SELECT email, plano, senha_hash FROM usuarios WHERE email = ?',
    [email]
  );
  if (!rows.length || !rows[0].senha_hash) return null;
  const valid = await verificarSenha(senha, rows[0].senha_hash);
  if (!valid) return null;
  return { email: rows[0].email, plano: rows[0].plano };
}
