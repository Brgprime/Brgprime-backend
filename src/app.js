import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';

import rateLimit from 'express-rate-limit';

import { env } from './config/env.js';
import { notFound, errorHandler } from './middleware/error.js';
import routes from './routes/index.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  // Security & performance middleware.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());

  // CORS — allow the configured origins (or all in dev with "*").
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || env.corsOrigin.includes('*') || env.corsOrigin.includes(origin)) {
          return cb(null, true);
        }
        return cb(null, false);
      },
      credentials: true,
    })
  );

  // Capture the raw body so the Paystack webhook can verify its signature.
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));

  if (!env.isProd) app.use(morgan('dev'));

  // Basic rate limiting on the API surface.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { message: 'Too many requests, please try again later.' } },
  });
  app.use('/api', limiter);

  // Health check.
  app.get('/', (_req, res) => {
    res.json({
      name: 'BRG Prime API',
      status: 'ok',
      version: '1.0.0',
      docs: '/api',
      time: new Date().toISOString(),
    });
  });

  app.use('/api', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
