import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { logger } from './utils/logger';
import videoRoutes from './routes/video.routes';
import systemRoutes from './routes/system.routes'; // Import the system routes
import { errorHandler } from './middlewares/error.middleware';

const app = express();

// --- Request logger middleware (runs before routes) -----------------------

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();

  // Capture the end of the response so we can log status + duration
  const originalEnd = res.end.bind(res);
  (res as any).end = function (...args: any[]) {
    const ms = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} — ${res.statusCode} ${ms}ms`, {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: ms,
      ip: req.ip,
    });
    return originalEnd(...args);
  };

  next();
});

// Security and Parsing Middlewares
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use('/api/v1/videos', videoRoutes);
app.use('/api/v1/system', systemRoutes); // Mount the system routes

// Health check endpoint
app.get('/health', (req, res) => res.status(200).json({ status: 'healthy' }));

// Unhandled Route Fallback
app.all('*', (req, res) => {
  res.status(404).json({ status: 'error', message: `Route ${req.originalUrl} not found.` });
});

// Centralized Error Handling
app.use(errorHandler);

export default app;