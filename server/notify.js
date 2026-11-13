// Optional instant alerts to the owner's phone through a Telegram bot.
// Messages never contain customer names or phone numbers.
import { config } from './config.js';

export async function notifyOwner(text) {
  const { token, chatId } = config.telegram;
  if (!token || !chatId) return;
  const link = config.publicUrl ? `\n${config.publicUrl}/admin/` : '';
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text + link, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.warn('Telegram notification failed:', e.message);
  }
}
