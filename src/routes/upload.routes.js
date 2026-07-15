import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import * as ctrl from '../controllers/upload.controller.js';

// Keep files in memory; we stream them straight to R2.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 10 }, // 8MB each, max 10
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

const router = Router();

router.get('/config', ctrl.config);
router.post('/image', requireAuth, upload.single('image'), ctrl.uploadSingle);
router.post('/images', requireAuth, upload.array('images', 10), ctrl.uploadMany);

export default router;
