// reminderManager.js
const reminders = {}; // { sessionName: [ { timeoutId, message, triggerTime } ] }

function scheduleReminder(sessionName, phoneNumber, message, delayMs, sendTextFn) {
    if (!reminders[sessionName]) {
        reminders[sessionName] = [];
    }

    const timeoutId = setTimeout(() => {
        sendTextFn(phoneNumber, message);
        reminders[sessionName] = reminders[sessionName].filter(r => r.timeoutId !== timeoutId);
    }, delayMs);

    reminders[sessionName].push({
        timeoutId,
        message,
        triggerTime: Date.now() + delayMs
    });
}

function getReminders(sessionName) {
    return reminders[sessionName] || [];
}

function clearReminders(sessionName) {
    if (reminders[sessionName]) {
        reminders[sessionName].forEach(r => clearTimeout(r.timeoutId));
        delete reminders[sessionName];
    }
}

// ✅ Exportação correta para ESModules
export { scheduleReminder, getReminders, clearReminders };
