import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as ctrl from '../controllers/favorite.controller.js';

const router = Router();

router.use(requireAuth);
router.get('/', ctrl.listFavorites);
router.get('/ids', ctrl.listFavoriteIds);
router.post('/:propertyId/toggle', ctrl.toggleFavorite);

export default router;
