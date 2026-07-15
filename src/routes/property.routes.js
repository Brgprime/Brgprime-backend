import { Router } from 'express';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/property.controller.js';
import {
  listPropertiesSchema, createPropertySchema, updatePropertySchema,
} from '../validators/property.validators.js';

const router = Router();

// Public/browse (optionalAuth marks isSaved when a token is present).
router.get('/', optionalAuth, validate(listPropertiesSchema, 'query'), ctrl.listProperties);
router.get('/featured', optionalAuth, ctrl.featured);
router.get('/recent', optionalAuth, ctrl.recent);
router.get('/mine', requireAuth, ctrl.myListings);
router.get('/:id', optionalAuth, ctrl.getProperty);

// Authenticated mutations.
router.post('/', requireAuth, validate(createPropertySchema), ctrl.createProperty);
router.patch('/:id', requireAuth, validate(updatePropertySchema), ctrl.updateProperty);
router.delete('/:id', requireAuth, ctrl.deleteProperty);

export default router;
