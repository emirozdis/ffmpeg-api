import { logger } from '../utils/logger';

export const sendWebhook = async (url: string, payload: any): Promise<void> => {
  try {
    logger.info(`[Webhook] Firing callback to ${url}`);
    
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (!res.ok) {
      logger.error(`[Webhook] Received non-200 response: ${res.status}`);
    } else {
      logger.info(`[Webhook] Successfully delivered callback.`);
    }
  } catch (err: any) {
    logger.error(`[Webhook] Delivery failed: ${err.message}`);
  }
};