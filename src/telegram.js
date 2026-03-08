// src/telegram.js
import fetch from "node-fetch";
import { CONFIG } from "./config.js";

export async function sendTelegram(text) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.error("[Telegram] Send failed:", err.message);
  }
}
