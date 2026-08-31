import { Router } from 'express';
import multer from 'multer';

import { requireAuth, requireAccess, requirePermission } from '../middleware/auth.js';
import { loadProject, loadDocument } from '../middleware/scope.js';
import { validate } from '../middleware/validate.js';
import { MAX_FILE_BYTES } from '../services/storage.service.js';

import * as projects from '../controllers/project.controller.js';
import * as documents from '../controllers/document.controller.js';
import * as boq from '../controllers/boq.controller.js';
import * as measurements from '../controllers/measurement.controller.js';
import * as variations from '../controllers/variation.controller.js';
import * as rates from '../controllers/rate.controller.js';
import * as estimation from '../controllers/estimation.controller.js';

import {
  createProjectSchema,
  updateProjectSchema,
  renameDocumentSchema,
  boqItemSchema,
  updateBoqItemSchema,
  importBoqSchema,
  measurementSchema,
  updateMeasurementSchema,
  createVariationSchema,
  updateVariationSchema,
  createRateSchema,
  updateRateSchema,
  rateQuerySchema,
  listQuerySchema,
  estimateQuerySchema,
  updateCostLineSchema,
} from '../validators/workspace.validators.js';

const router = Router();

const uploadDoc = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });
const uploadCsv = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Everything below requires a signed-in user with a live trial or subscription.
// requireAccess is the server-side paywall — §16 lists the client-side one as a
// Critical hole because editing localStorage restores access.
router.use(requireAuth, requireAccess);

// ─── Projects ────────────────────────────────────────────────────────────────
router.get('/projects', validate(listQuerySchema, 'query'), projects.list);
router.post(
  '/projects',
  requirePermission('projects:write'),
  validate(createProjectSchema),
  projects.create
);
router.get('/projects/:projectId', loadProject(), projects.get);
router.patch(
  '/projects/:projectId',
  requirePermission('projects:write'),
  loadProject(),
  validate(updateProjectSchema),
  projects.update
);
router.delete(
  '/projects/:projectId',
  requirePermission('projects:write'),
  loadProject(),
  projects.remove
);
router.get('/projects/:projectId/activity', loadProject(), projects.activity);
router.get('/projects/:projectId/spend', loadProject(), projects.spend);

// ─── Documents ───────────────────────────────────────────────────────────────
router.post(
  '/projects/:projectId/documents',
  requirePermission('documents:upload'),
  loadProject(),
  uploadDoc.single('file'),
  documents.upload
);
router.get('/projects/:projectId/documents', loadProject(), documents.listForProject);
router.get('/documents/:documentId', loadDocument(), documents.get);
router.get('/documents/:documentId/download', loadDocument(), documents.download);
router.get('/documents/:documentId/preview', loadDocument(), documents.preview);
router.patch(
  '/documents/:documentId',
  requirePermission('documents:upload'),
  loadDocument(),
  validate(renameDocumentSchema),
  documents.rename
);
router.delete(
  '/documents/:documentId',
  requirePermission('documents:upload'),
  loadDocument(),
  documents.remove
);

// ─── Takeoff measurements ────────────────────────────────────────────────────
router.get('/documents/:documentId/measurements', loadDocument(), measurements.listForDocument);
router.post(
  '/documents/:documentId/measurements',
  requirePermission('documents:upload'),
  loadDocument(),
  validate(measurementSchema),
  measurements.create
);
router.get('/projects/:projectId/measurements', loadProject(), measurements.listForProject);
router.patch(
  '/measurements/:measurementId',
  requirePermission('documents:upload'),
  validate(updateMeasurementSchema),
  measurements.update
);
router.delete(
  '/measurements/:measurementId',
  requirePermission('documents:upload'),
  measurements.remove
);

// ─── Bill of quantities ──────────────────────────────────────────────────────
router.get('/projects/:projectId/boq', loadProject(), boq.get);
router.get('/projects/:projectId/boq/revisions', loadProject(), boq.revisions);
router.get('/projects/:projectId/boq/export', loadProject(), boq.exportBoq);
router.post(
  '/projects/:projectId/boq/items',
  requirePermission('boq:write'),
  loadProject(),
  validate(boqItemSchema),
  boq.addItem
);
router.post(
  '/projects/:projectId/boq/import',
  requirePermission('boq:write'),
  loadProject(),
  validate(importBoqSchema),
  boq.importFromTakeoff
);
router.patch(
  '/boq/items/:itemId',
  requirePermission('boq:write'),
  validate(updateBoqItemSchema),
  boq.updateItem
);
router.delete('/boq/items/:itemId', requirePermission('boq:write'), boq.deleteItem);

// ─── Variations ──────────────────────────────────────────────────────────────
router.get('/projects/:projectId/variations', loadProject(), variations.list);
router.post(
  '/projects/:projectId/variations',
  requirePermission('projects:write'),
  loadProject(),
  validate(createVariationSchema),
  variations.create
);
router.patch('/variations/:variationId', validate(updateVariationSchema), variations.update);
router.delete('/variations/:variationId', requirePermission('projects:write'), variations.remove);

// ─── Pricing database ────────────────────────────────────────────────────────
router.get('/rates', validate(rateQuerySchema, 'query'), rates.list);
router.post('/rates', requirePermission('rates:write'), validate(createRateSchema), rates.create);
router.patch(
  '/rates/:rateId',
  requirePermission('rates:write'),
  validate(updateRateSchema),
  rates.update
);
router.delete('/rates/:rateId', requirePermission('rates:write'), rates.remove);
router.get('/rates/:rateId/history', rates.history);
router.post(
  '/rates/import',
  requirePermission('rates:write'),
  uploadCsv.single('file'),
  rates.importCsv
);

// ─── Estimation ──────────────────────────────────────────────────────────────
router.get('/regions', estimation.regions);
router.get(
  '/projects/:projectId/estimate',
  loadProject(),
  validate(estimateQuerySchema, 'query'),
  estimation.estimate
);
router.post('/projects/:projectId/estimate/recalculate', loadProject(), estimation.recalculate);
router.get('/projects/:projectId/costs', loadProject(), estimation.listCosts);
router.post(
  '/projects/:projectId/costs/import',
  requirePermission('projects:write'),
  loadProject(),
  uploadCsv.single('file'),
  estimation.importCosts
);
router.delete(
  '/projects/:projectId/costs',
  requirePermission('projects:write'),
  loadProject(),
  estimation.clearCosts
);
router.patch(
  '/costs/:costLineId',
  requirePermission('projects:write'),
  validate(updateCostLineSchema),
  estimation.updateCostLine
);
router.delete(
  '/costs/:costLineId',
  requirePermission('projects:write'),
  estimation.removeCostLine
);

export default router;
