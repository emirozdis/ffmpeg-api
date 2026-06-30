import { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export const requireApiKey = (req: Request, res: Response, next: NextFunction): void => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    logger.warn('API Key is missing in request', {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
    });
    return next(new AppError('API Key is missing in headers (x-api-key).', 401));
  }

  if (apiKey !== config.API_KEY) {
    logger.warn('Invalid API Key provided', {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
    });
    return next(new AppError('Invalid API Key provided.', 403));
  }

  logger.debug('API Key authenticated', { method: req.method, url: req.originalUrl, ip: req.ip });
  next();
};
