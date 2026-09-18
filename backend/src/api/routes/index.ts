import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { apiKeyAuth, optionalApiKeyAuth } from '../middleware/auth';
import { generalRateLimit, runRateLimit } from '../middleware/rate-limit';
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
 *
 * ## Middleware order
 * Liveness is mounted first and stays unauthenticated so an orchestrator can
 * probe a process that has not been given a key yet. Readiness runs auth in
 * *optional* mode: it answers either way, but only an authenticated caller gets
 * the detailed diagnostics (audit finding S10).
 *
 * Everything below `apiKeyAuth` requires a caller. The general rate limit sits
 * immediately after it, and the much tighter `runRateLimit` is attached
 * per-route to the handful of endpoints that start model work — those are the
 * ones where one admitted request costs dollars and minutes (audit finding S9).
 */
export const router = Router();

// --- Health ----------------------------------------------------------------
router.get('/health', asyncHandler(healthController.health));
// Optional auth: unauthenticated callers get a bare status, operators get detail.
router.get('/health/ready', optionalApiKeyAuth, asyncHandler(healthController.ready));

router.use(apiKeyAuth);
router.use(generalRateLimit);

// --- Projects --------------------------------------------------------------
// Cloning and indexing a repository is expensive and touches the filesystem.
router.post('/projects/connect', runRateLimit, asyncHandler(projectController.connect));
router.get('/projects', asyncHandler(projectController.list));
router.get('/projects/:id', asyncHandler(projectController.get));
router.get('/projects/:id/memory', asyncHandler(projectController.memory));
router.get('/projects/:id/status', asyncHandler(projectController.status));
router.post('/projects/:id/reanalyze', runRateLimit, asyncHandler(projectController.reanalyze));
router.patch('/projects/:id/instructions', asyncHandler(projectController.updateInstructions));
router.delete('/projects/:id', asyncHandler(projectController.disconnect));

// --- Tasks -----------------------------------------------------------------
router.post('/tasks', runRateLimit, asyncHandler(taskController.create));
router.get('/tasks', asyncHandler(taskController.list));
router.post('/tasks/run-ready', runRateLimit, asyncHandler(taskController.runReady));
router.get('/tasks/:id', asyncHandler(taskController.get));
router.post('/tasks/:id/run', runRateLimit, asyncHandler(taskController.run));
router.post('/tasks/:id/approve', asyncHandler(taskController.approve));
router.post('/tasks/:id/status', asyncHandler(taskController.setStatus));

// --- Agents ----------------------------------------------------------------
router.get('/agents', asyncHandler(agentController.list));
router.post('/agents/run', runRateLimit, asyncHandler(agentController.run));
router.post('/agents/route', asyncHandler(agentController.route));
router.get('/agents/messages', asyncHandler(agentController.messages));
router.post('/agents/messages', asyncHandler(agentController.sendMessage));
router.get('/agents/:key', asyncHandler(agentController.get));

// --- Workflows -------------------------------------------------------------
router.get('/workflows', asyncHandler(workflowController.list));
router.post('/workflows/run', runRateLimit, asyncHandler(workflowController.start));
router.get('/workflows/runs', asyncHandler(workflowController.listRuns));
router.get('/workflows/runs/:id', asyncHandler(workflowController.getRun));
router.post('/workflows/runs/:id/approve', runRateLimit, asyncHandler(workflowController.approveStep));
router.post('/workflows/runs/:id/resume', runRateLimit, asyncHandler(workflowController.resume));
router.post('/workflows/runs/:id/cancel', asyncHandler(workflowController.cancel));
