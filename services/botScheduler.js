import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SESSIONS } from '../state.js';
import { startScheduledConversation } from './agentProcessor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const AGENTS_DIR = path.join(__dirname, '..', 'data', 'agents');
const INDEX_FILE = path.join(AGENTS_DIR, '_index.json');

// Map: `${email}::${agentId}` -> ScheduledTask
const jobs = new Map();

function loadEmailIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch { return {}; }
}

function resolveEmail(safeName) {
  // Fonte primária: índice persistido — funciona mesmo sem sessões ativas
  const index = loadEmailIndex();
  if (index[safeName]) return index[safeName];

  // Fallback: sessões em memória (caso o índice ainda não exista)
  for (const session of SESSIONS.values()) {
    const safe = (session.email || '').replace(/[^a-z0-9._-]/gi, '_');
    if (safe === safeName) return session.email;
  }
  return null;
}

export function refreshScheduler() {
  for (const task of jobs.values()) task.destroy();
  jobs.clear();

  if (!fs.existsSync(AGENTS_DIR)) return;

  const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  let count = 0;

  for (const file of files) {
    const email = resolveEmail(file.replace('.json', ''));
    if (!email) continue;

    let agents;
    try { agents = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8')); }
    catch { continue; }

    for (const agent of agents) {
      if (!agent.active || !agent.scheduledBot?.enabled) continue;
      const cronExpr = (agent.scheduledBot.cronExpr || '').trim();
      if (!cronExpr || !cron.validate(cronExpr)) {
        console.warn(`⏰ Cron inválido no agente "${agent.name}": "${cronExpr}"`);
        continue;
      }

      const key  = `${email}::${agent.id}`;
      const task = cron.schedule(cronExpr, () => fireBot(agent, email), {
        timezone: 'America/Sao_Paulo',
      });
      jobs.set(key, task);
      count++;
      console.log(`⏰ Agendado: "${agent.name}" | ${cronExpr}`);
    }
  }

  console.log(`⏰ Scheduler: ${count} job(s) ativo(s)`);
}

export async function fireBotNow(agentId, email) {
  const file = path.join(AGENTS_DIR, `${email.replace(/[^a-z0-9._-]/gi, '_')}.json`);
  let agents;
  try { agents = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Agentes não encontrados para este usuário'); }

  const agent = agents.find(a => a.id === agentId);
  if (!agent) throw new Error('Agente não encontrado');
  if (!agent.scheduledBot?.enabled) throw new Error('Bot agendado não está ativado neste agente');

  await fireBot(agent, email);
  return { contacts: (agent.scheduledBot.contacts || '').split(',').map(c => c.trim()).filter(Boolean) };
}

async function fireBot(agent, email) {
  const contacts = (agent.scheduledBot.contacts || '')
    .split(',').map(c => c.trim()).filter(Boolean);
  const message = (agent.scheduledBot.message || '').trim();
  if (!contacts.length || !message) return;

  const sessionEntry = [...SESSIONS.entries()].find(([, s]) => s.email === email);
  if (!sessionEntry) {
    console.warn(`⏰ Sem sessão ativa para disparo do agente "${agent.name}"`);
    return;
  }

  const [sessionName, session] = sessionEntry;
  if (!session?.client) return;

  for (const contact of contacts) {
    try {
      await session.client.sendText(contact, message);
      startScheduledConversation(sessionName, contact, agent.id, email);
      console.log(`⏰ Disparado para ${contact} | agente: "${agent.name}"`);
    } catch (err) {
      console.error(`⏰ Erro ao disparar para ${contact}:`, err.message);
    }
  }
}
