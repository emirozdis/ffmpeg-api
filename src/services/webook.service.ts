import { logger } from '../utils/logger';
import { config } from '../config/env'; // Import config to use the API_KEY or a specific WEBHOOK_SECRET

export const sendWebhook = async (url: string, payload: any): Promise<void> => {
  try {
    logger.info(`[Webhook] Firing callback to ${url}`);
    
    const res = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-webhook-secret': config.API_KEY // <-- ADD THIS: Securely sign the request
      },
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