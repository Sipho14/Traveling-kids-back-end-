// Thin wrapper around Meta's WhatsApp Cloud API.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api

const GRAPH_URL = 'https://graph.facebook.com/v21.0';

function apiUrl() {
  return `${GRAPH_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

async function callGraphApi(payload) {
  const res = await fetch(apiUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('WhatsApp API error:', JSON.stringify(data));
    throw new Error(data?.error?.message || 'WhatsApp send failed');
  }
  return data;
}

export async function sendText(to, body) {
  return callGraphApi({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body, preview_url: true }
  });
}

// Buttons are how we hand the parent quick actions (Track ride / Pay now / Talk to a person)
// instead of making them type. Max 3 buttons per WhatsApp's own limit.
export async function sendButtons(to, bodyText, buttons) {
  return callGraphApi({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b, i) => ({
          type: 'reply',
          reply: { id: b.id || `btn_${i}`, title: b.title.slice(0, 20) }
        }))
      }
    }
  });
}

export async function markAsRead(messageId) {
  return callGraphApi({
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId
  });
}

// Extracts a plain-text body from any inbound WhatsApp message shape
// (text, button reply, or list reply) so the AI agent has one consistent input.
export function extractInboundText(message) {
  if (message.type === 'text') return message.text.body;
  if (message.type === 'interactive') {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      ''
    );
  }
  return '';
}
