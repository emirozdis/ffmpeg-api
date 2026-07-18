import { createHmac, randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { config } from '../config/env';

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const sendWebhook = async (url: string, payload: unknown): Promise<void> => {
  if (!config.WEBHOOK_SECRET || config.WEBHOOK_SECRET.length < 32) {
    throw new Error('TRANSCODER_WEBHOOK_SECRET must contain at least 32 characters');
  }
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/api/webhooks/transcoder' || target.search || target.hash ||
      !config.ALLOWED_WEBHOOK_ORIGINS.includes(target.origin)) {
    throw new Error('Webhook target is not allowlisted');
  }

  const body = JSON.stringify(payload);
  const eventId = randomUUID();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', config.WEBHOOK_SECRET)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-id': eventId,
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (res.ok) {
        logger.info(`[Webhook] Successfully delivered callback ${eventId}.`);
        return;
      }
      lastError = new Error(`Webhook returned HTTP ${res.status}`);
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < 3) await wait(attempt * 500);
  }

  logger.error(`[Webhook] Delivery failed for ${eventId}: ${lastError?.message}`);
};
