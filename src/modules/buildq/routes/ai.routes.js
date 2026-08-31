import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

import { requireAuth, requireAccess, requirePermission, requireCredits } from '../middleware/auth.js';
import { loadProject, loadDocument } from '../middleware/scope.js';
import { MAX_FILE_BYTES } from '../services/storage.service.js';
import * as analysis from '../controllers/analysis.controller.js';
import * as assistant from '../controllers/assistant.controller.js';

const router = Router();

const uploadDrawing = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

// Analysis and chat both cost real money per call, so they get a tighter limit
// than the rest of the API (§16 asks for rate limiting on upload and analysis).
const engineLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many analysis requests. Give the engine a moment.',
    },
  },
});

router.use(requireAuth, requireAccess);

// ─── Analysis engine (§12) ───────────────────────────────────────────────────
router.post(
  '/analyze',
  engineLimiter,
  requireCredits,
  requirePermission('documents:upload'),
  uploadDrawing.single('file'),
  analysis.analyze
);
router.get('/analyze/:jobId', analysis.jobStatus);
router.post('/boq', engineLimiter, requireCredits, requirePermission('boq:write'), analysis.boqFromDocuments);

router.post(
  '/documents/:documentId/detect',
  engineLimiter,
  requireCredits,
  requirePermission('documents:upload'),
  loadDocument(),
  analysis.detect
);

router.post(
  '/projects/:projectId/boq/generate',
  engineLimiter,
  requireCredits,
  requirePermission('boq:write'),
  loadProject(),
  analysis.generateForProject
);

// ─── Assistant ───────────────────────────────────────────────────────────────
router.get('/assistant/status', assistant.status);
router.post('/assistant/chat', engineLimiter, requireCredits, assistant.chatWithAssistant);
router.get('/assistant/threads', assistant.listThreads);
router.get('/assistant/threads/:threadId', assistant.getThread);
router.delete('/assistant/threads/:threadId', assistant.deleteThread);

export default router;
