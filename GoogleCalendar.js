// googleCalendar.js
const { google } = require("googleapis");
const fs = require("fs");

// Carregar credenciais da conta de serviço
const credentials = JSON.parse(fs.readFileSync("/Credentials_Google/client_secret_706750233282-cnonlcurck7i0ro7go9dfuebblfb7o86.apps.googleusercontent.com.json"));

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

/**
 * Lista os eventos do Google Calendar
 */
async function listEvents() {
    const res = await calendar.events.list({
        calendarId: "primary",
        timeMin: new Date().toISOString(),
        singleEvents: true,
        orderBy: "startTime",
    });
    return res.data.items;
}

/**
 * Cria um evento no Google Calendar
 */
async function createEvent(eventData) {
    const res = await calendar.events.insert({
        calendarId: "primary",
        resource: eventData,
    });
    return res.data;
}

/**
 * Exclui um evento do Google Calendar
 */
async function deleteEvent(eventId) {
    await calendar.events.delete({
        calendarId: "primary",
        eventId: eventId,
    });
    return { message: "Evento excluído" };
}

// Exporta as funções
module.exports = { listEvents, createEvent, deleteEvent };
