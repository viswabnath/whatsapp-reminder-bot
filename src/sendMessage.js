const axios = require("axios");
require("dotenv").config();

/**
 * Sends an outbound WhatsApp message via the Meta Cloud API.
 * Throws on non-2xx responses — callers should handle appropriately.
 */
/**
 * Sends an outbound WhatsApp message via the Meta Cloud API.
 * Supports both plain text and Message Templates.
 * 
 * @param {string} phone - Recipient phone number with country code.
 * @param {string} message - Plain text message OR variable content for template {{1}}
 * @param {object} [options] - Optional settings for template-based sending.
 * @param {string} [options.templateName] - Name of the pre-approved Meta template.
 * @param {string} [options.languageCode='en_US'] - Language code for the template.
 */
async function sendWhatsAppMessage(phone, message, options = {}) {
  const { templateName, languageCode = "en_US" } = options;

  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const headers = {
    Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  let payload;

  if (templateName) {
    // Message Template Payload (bypasses 24h window)
    payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: message }
            ]
          }
        ]
      }
    };
  } else {
    // Standard Plain Text Payload (requires 24h window)
    payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message },
    };
  }

  await axios.post(url, payload, { headers });
}

module.exports = sendWhatsAppMessage;