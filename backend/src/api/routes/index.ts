import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { apiKeyAuth } from '../middleware/auth';
import { projectController } from '../controllers/project.controller';
import { taskController } from '../controllers/task.controller';
import { agentController } from '../controllers/agent.controller';
import { workflowController } from '../controllers/workflow.controller';
import { healthController } from '../controllers/health.controller';

/**
 * API surface.
 *
 * Grouped by resource; every handler is wrapped in `asyncHandler` so a rejected
 * promise reaches the error middleware instead of crashing the process.
 * Health is mounted before auth so an orchestrator can probe it without a key.
 */
export const router = Router();

// --- Health (unauthenticated) ---------------------------------------------
router.get('/health', asyncHandler(healthController.health));
router.get('/health/ready', asyncHandler(healthController.ready));

router.use(apiKeyAuth);

// --- Projects --------------------------------------------------------------
router.post('/projects/connect', asyncHandler(projectController.connect));
router.get('/projects', asyncHandler(projectController.list));
router.get('/projects/:id', asyncHandler(projectController.get));
router.get('/projects/:id/memory', asyncHandler(projectController.memory));
router.get('/projects/:id/status', asyncHandler(projectController.status));
router.post('/projects/:id/reanalyze', asyncHandler(projectController.reanalyze));
router.patch('/projects/:id/instructions', asyncHandler(projectController.updateInstructions));
router.delete('/projects/:id', asyncHandler(projectController.disconnect));

// --- Tasks -----------------------------------------------------------------
router.post('/tasks', asyncHandler(taskController.create));
router.get('/tasks', asyncHandler(taskController.list));
router.post('/tasks/run-ready', asyncHandler(taskController.runReady));
router.get('/tasks/:id', asyncHandler(taskController.get));
router.post('/tasks/:id/run', asyncHandler(taskController.run));
router.post('/tasks/:id/approve', asyncHandler(taskController.approve));
router.post('/tasks/:id/status', asyncHandler(taskController.setStatus));

// --- Agents ----------------------------------------------------------------
router.get('/agents', asyncHandler(agentController.list));
router.post('/agents/run', asyncHandler(agentController.run));
router.post('/agents/route', asyncHandler(agentController.route));
router.get('/agents/messages', asyncHandler(agentController.messages));
router.post('/agents/messages', asyncHandler(agentController.sendMessage));
router.get('/agents/:key', asyncHandler(agentController.get));

// --- Workflows -------------------------------------------------------------
router.get('/workflows', asyncHandler(workflowController.list));
router.post('/workflows/run', asyncHandler(workflowController.start));
router.get('/workflows/runs', asyncHandler(workflowController.listRuns));
router.get('/workflows/runs/:id', asyncHandler(workflowController.getRun));
router.post('/workflows/runs/:id/approve', asyncHandler(workflowController.approveStep));
router.post('/workflows/runs/:id/resume', asyncHandler(workflowController.resume));
router.post('/workflows/runs/:id/cancel', asyncHandler(workflowController.cancel));
