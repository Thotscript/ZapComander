import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

// Ajuste para pegar o caminho do arquivo no ESModule
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Caminho para sua chave JSON
const keyFile = path.join(__dirname, 'wpptalk-assist-2ed1a7fa5b2a.json'); // ajuste aqui o nome correto

// Autenticação
const auth = new google.auth.GoogleAuth({
  keyFile: keyFile,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

// Inicializa cliente do Calendar
const calendar = google.calendar({ version: 'v3', auth });

/**
 * Cria um evento no Google Calendar
 * @param {string} dia - Data no formato 'YYYY-MM-DD'
 * @param {string} hora - Hora no formato 'HH:mm'
 * @param {string} titulo - Título do evento
 * @param {number} duracaoEmMinutos - Duração do evento em minutos
 */
export async function criarEvento(dia, hora, titulo, duracaoEmMinutos = 60) {
  try {
    const authClient = await auth.getClient();

    const calendarId = 'jurandir@thesalesjourney.io';

    const startDateTime = new Date(`${dia}T${hora}:00`);
    const endDateTime = new Date(startDateTime.getTime() + duracaoEmMinutos * 60 * 1000);

    const event = {
      summary: titulo,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: 'America/Sao_Paulo',
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: 'America/Sao_Paulo',
      },
      attendees: [
        { email: 'jurandir@thesalesjourney.io' },
      ],
    };

    const response = await calendar.events.insert({
      auth: authClient,
      calendarId: calendarId,
      resource: event,
      sendUpdates: 'all',
    });

    console.log('✅ Evento criado:', response.data.htmlLink);
    return response.data;
  } catch (error) {
    console.error('❌ Erro ao criar evento:', error);
    throw error;
  }
}
