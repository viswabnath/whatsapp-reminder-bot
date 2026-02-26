const pool = require("./db");
const { extractTime } = require("./parser");

async function handleIncomingMessage(req, res) {
    const body = req.body;

    if (body.entry && body.entry[0].changes) {
        const messageData = body.entry[0].changes[0].value.messages;

        if (messageData) {
            const message = messageData[0].text.body;
            const phone = messageData[0].from;

            const reminderTime = extractTime(message);

            if (reminderTime) {
                await pool.query(
                    "INSERT INTO reminders (phone, message, reminder_time) VALUES ($1, $2, $3)",
                    [phone, message, reminderTime]
                );
            }
        }
    }

    res.sendStatus(200);
}

module.exports = handleIncomingMessage;