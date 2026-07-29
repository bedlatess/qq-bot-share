import type { BotConfig } from './config.js';

function apiUrl(bot: BotConfig, path: string) {
  return `${bot.webuiUrl.replace(/\/+$/, '')}/api/QQLogin/${path}`;
}

async function post(bot: BotConfig, path: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(apiUrl(bot, path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bot.webuiToken ? { authorization: `Bearer ${bot.webuiToken}` } : {}),
      },
      body: '{}',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok || payload.code && payload.code !== 0) throw new Error(payload.message || `NapCat HTTP ${response.status}`);
    return payload.data ?? payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function napCatOperation(bot: BotConfig, operation: 'status' | 'qrcode' | 'refresh_qrcode' | 'restart') {
  if (operation === 'status') {
    const [status, info] = await Promise.all([
      post(bot, 'CheckLoginStatus'),
      post(bot, 'GetQQLoginInfo').catch(() => null),
    ]);
    return { ...status, info };
  }
  if (operation === 'qrcode') return post(bot, 'GetQQLoginQrcode');
  if (operation === 'refresh_qrcode') return post(bot, 'RefreshQRcode');
  return post(bot, 'RestartNapCat');
}

