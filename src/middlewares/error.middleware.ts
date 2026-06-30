import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';

  // Handle Multer specifically
  if (err instanceof multer.MulterError) {
    statusCode = 400;
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = 'File size is too large. Max limit is 500MB.';
    }
  }

  // Log the error with full details to file (regardless of LOG_LEVEL for console)
  logger.error(`${req.method} ${req.originalUrl} — ${statusCode} ${message}`, {
    method: req.method,
    url: req.originalUrl,
    statusCode,
    message,
    stack: err.stack,
    ip: req.ip,
  });

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
};
