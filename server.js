/**
 * server.js
 * 
 * REST API wrapper for ProjectScheduler.js
 * Exposes the CPM scheduling engine as HTTP endpoints for PMO software integration
 * 
 * Requires: express, cors
 *   npm install express cors
 * 
 * Assumes ProjectScheduler.js sits alongside this file and exports:
 *   { ProjectScheduler, createProjectSchedule, RELATION_TYPES, TASK_STATUS }
 * 
 * Run: node server.js
 * Default port: 3000 (override with PORT env var)
 */

const express = require('express');
const cors = require('cors');
const { createProjectSchedule, RELATION_TYPES, TASK_STATUS } = require('./ProjectScheduler');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ============================================================
// IN-MEMORY PROJECT STORE
// Swap this Map for your PMO database layer in production -
// e.g. load/save exportSchedule()/importSchedule() JSON per project.
// ============================================================

const projects = new Map(); // projectId -> ProjectScheduler instance

// ============================================================
// HELPERS
// ============================================================

/**
 * Wrap async route handlers so thrown errors reach the error middleware
 * instead of crashing the process.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Fetch a project or send a 404. Returns null if not found (caller must return).
 */
function getProjectOr404(req, res) {
  const scheduler = projects.get(req.params.projectId);
  if (!scheduler) {
    res.status(404).json({ error: `Project "${req.params.projectId}" not found` });
    return null;
  }
  return scheduler;
}

/**
 * Standard error response shape for caught exceptions from ProjectScheduler
 * (which throws plain Error objects with human-readable messages).
 */
function sendError(res, status, err) {
  res.status(status).json({ error: err.message || String(err) });
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', projectCount: projects.size, timestamp: new Date().toISOString() });
});

app.get('/api/meta', (req, res) => {
  res.json({ relationTypes: RELATION_TYPES, taskStatuses: TASK_STATUS });
});

// ============================================================
// PROJECT ENDPOINTS
// ============================================================

/**
 * POST /api/projects
 * Body: { projectId, projectName, startDate, workingDays?, holidays? }
 * Creates a new project scheduler instance.
 */
app.post('/api/projects', asyncHandler(async (req, res) => {
  const { projectId } = req.body;

  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }
  if (projects.has(projectId)) {
    return res.status(409).json({ error: `Project "${projectId}" already exists` });
  }

  const scheduler = createProjectSchedule(req.body);
  projects.set(projectId, scheduler);

  res.status(201).json({ message: 'Project created', project: scheduler.getProjectSummary() });
}));

/**
 * GET /api/projects
 * List all projects (summary only).
 */
app.get('/api/projects', asyncHandler(async (req, res) => {
  const summaries = Array.from(projects.values()).map(s => {
    try {
      return s.getProjectSummary();
    } catch {
      // No tasks yet - return minimal info
      return { projectId: s.projectId, projectName: s.projectName, totalTasks: 0 };
    }
  });
  res.json({ count: summaries.length, projects: summaries });
}));

/**
 * GET /api/projects/:projectId
 * Full schedule export for one project (tasks, dependencies, critical path, baselines).
 */
app.get('/api/projects/:projectId', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    res.json(scheduler.exportSchedule());
  } catch (err) {
    // No tasks yet
    res.json({
      project: { projectId: scheduler.projectId, projectName: scheduler.projectName },
      tasks: [],
      dependencies: [],
      message: 'Project has no tasks yet'
    });
  }
}));

/**
 * PUT /api/projects/:projectId
 * Update project-level settings (name, working days, holidays). Start date changes
 * are allowed but will shift the whole schedule on next calculate.
 */
app.put('/api/projects/:projectId', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  const { projectName, startDate, workingDays, holidays } = req.body;
  if (projectName !== undefined) scheduler.projectName = projectName;
  if (startDate !== undefined) scheduler.startDate = new Date(startDate);
  if (workingDays !== undefined) scheduler.workingDays = workingDays;
  if (holidays !== undefined) scheduler.holidays = holidays.map(d => new Date(d));

  res.json({ message: 'Project updated', projectId: scheduler.projectId });
}));

/**
 * DELETE /api/projects/:projectId
 */
app.delete('/api/projects/:projectId', asyncHandler(async (req, res) => {
  if (!projects.has(req.params.projectId)) {
    return res.status(404).json({ error: `Project "${req.params.projectId}" not found` });
  }
  projects.delete(req.params.projectId);
  res.json({ message: 'Project deleted' });
}));

/**
 * POST /api/projects/:projectId/import
 * Replace a project's tasks/dependencies from an exportSchedule()-shaped payload.
 * Useful for restoring from a PMO database record.
 */
app.post('/api/projects/:projectId/import', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    scheduler.importSchedule(req.body);
    res.json({ message: 'Schedule imported', projectId: scheduler.projectId });
  } catch (err) {
    sendError(res, 400, err);
  }
}));

// ============================================================
// TASK ENDPOINTS
// ============================================================

/**
 * GET /api/projects/:projectId/tasks
 */
app.get('/api/projects/:projectId/tasks', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;
  res.json({ tasks: scheduler.getAllTasks() });
}));

/**
 * GET /api/projects/:projectId/tasks/:taskId
 */
app.get('/api/projects/:projectId/tasks/:taskId', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  const task = scheduler.getTask(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: `Task "${req.params.taskId}" not found` });
  }
  res.json({ task });
}));

/**
 * POST /api/projects/:projectId/tasks
 * Body: taskId, name, duration, wbsCode, percentComplete, isMilestone, resourceIds, workstream, notes...
 */
app.post('/api/projects/:projectId/tasks', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    const task = scheduler.addTask(req.body);
    res.status(201).json({ message: 'Task added', task });
  } catch (err) {
    sendError(res, 400, err);
  }
}));

/**
 * PUT /api/projects/:projectId/tasks/:taskId
 * Body: any updatable task fields
 */
app.put('/api/projects/:projectId/tasks/:taskId', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    const task = scheduler.updateTask(req.params.taskId, req.body);
    res.json({ message: 'Task updated', task });
  } catch (err) {
    sendError(res, 404, err);
  }
}));

/**
 * DELETE /api/projects/:projectId/tasks/:taskId
 */
app.delete('/api/projects/:projectId/tasks/:taskId', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  const deleted = scheduler.deleteTask(req.params.taskId);
  if (!deleted) {
    return res.status(404).json({ error: `Task "${req.params.taskId}" not found` });
  }
  res.json({ message: 'Task deleted' });
}));

/**
 * POST /api/projects/:projectId/tasks/:taskId/actuals
 * Body: { actualStart?, actualFinish?, percentComplete?, status? }
 * Record real-world progress against a task.
 */
app.post('/api/projects/:projectId/tasks/:taskId/actuals', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    const task = scheduler.recordActual(req.params.taskId, req.body);
    res.json({ message: 'Actuals recorded', task });
  } catch (err) {
    sendError(res, 404, err);
  }
}));

// ============================================================
// DEPENDENCY ENDPOINTS
// ============================================================

/**
 * GET /api/projects/:projectId/dependencies
 */
app.get('/api/projects/:projectId/dependencies', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;
  res.json({ dependencies: scheduler.dependencies });
}));

/**
 * POST /api/projects/:projectId/dependencies
 * Body: { taskId, predecessorId, relationType?, lagDays? }
 */
app.post('/api/projects/:projectId/dependencies', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    const dependency = scheduler.addDependency(req.body);
    res.status(201).json({ message: 'Dependency added', dependency });
  } catch (err) {
    sendError(res, 400, err);
  }
}));

/**
 * DELETE /api/projects/:projectId/dependencies
 * Body or query: { taskId, predecessorId }
 */
app.delete('/api/projects/:projectId/dependencies', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  const taskId = req.body.taskId || req.query.taskId;
  const predecessorId = req.body.predecessorId || req.query.predecessorId;

  if (!taskId || !predecessorId) {
    return res.status(400).json({ error: 'taskId and predecessorId are required' });
  }

  const removed = scheduler.removeDependency(taskId, predecessorId);
  if (!removed) {
    return res.status(404).json({ error: 'Dependency not found' });
  }
  res.json({ message: 'Dependency removed' });
}));

// ============================================================
// SCHEDULE CALCULATION / GANTT / VALIDATION
// ============================================================

/**
 * POST /api/projects/:projectId/calculate
 * Runs the CPM forward/backward pass. Returns project-level results.
 */
app.post('/api/projects/:projectId/calculate', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  const result = scheduler.calculateSchedule();
  if (!result.success) {
    return res.status(422).json(result);
  }
  res.json(result);
}));

/**
 * GET /api/projects/:projectId/gantt
 * Gantt-ready row data (recalculates automatically if stale).
 */
app.get('/api/projects/:projectId/gantt', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    res.json({ tasks: scheduler.getGanttData() });
  } catch (err) {
    sendError(res, 422, err);
  }
}));

/**
 * GET /api/projects/:projectId/summary
 */
app.get('/api/projects/:projectId/summary', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    res.json(scheduler.getProjectSummary());
  } catch (err) {
    sendError(res, 422, err);
  }
}));

/**
 * GET /api/projects/:projectId/validate
 * Runs pre-flight checks (orphan tasks, zero-duration non-milestones, circular deps, etc.)
 */
app.get('/api/projects/:projectId/validate', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  res.json(scheduler.validateSchedule());
}));

// ============================================================
// BASELINE & VARIANCE ENDPOINTS
// ============================================================

/**
 * GET /api/projects/:projectId/baselines
 */
app.get('/api/projects/:projectId/baselines', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;
  res.json({ baselines: scheduler.listBaselines() });
}));

/**
 * POST /api/projects/:projectId/baselines
 * Body: { baselineId, label?, setActive? }
 * Captures a snapshot of the current calculated schedule.
 */
app.post('/api/projects/:projectId/baselines', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  const { baselineId, label, setActive } = req.body;

  try {
    scheduler.captureBaseline(baselineId, { label, setActive });
    res.status(201).json({ message: 'Baseline captured', baselines: scheduler.listBaselines() });
  } catch (err) {
    sendError(res, 400, err);
  }
}));

/**
 * PUT /api/projects/:projectId/baselines/active
 * Body: { baselineId }
 */
app.put('/api/projects/:projectId/baselines/active', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    scheduler.setActiveBaseline(req.body.baselineId);
    res.json({ message: 'Active baseline updated', activeBaselineId: scheduler.activeBaselineId });
  } catch (err) {
    sendError(res, 404, err);
  }
}));

/**
 * DELETE /api/projects/:projectId/baselines/:baselineId
 */
app.delete('/api/projects/:projectId/baselines/:baselineId', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  const removed = scheduler.deleteBaseline(req.params.baselineId);
  if (!removed) {
    return res.status(404).json({ error: `Baseline "${req.params.baselineId}" not found` });
  }
  res.json({ message: 'Baseline deleted' });
}));

/**
 * GET /api/projects/:projectId/variance?baselineId=BL0
 * Full baseline-vs-actual variance report. Uses the active baseline if
 * baselineId query param is omitted.
 */
app.get('/api/projects/:projectId/variance', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    const report = scheduler.getVarianceReport(req.query.baselineId);
    res.json(report);
  } catch (err) {
    sendError(res, 400, err);
  }
}));

/**
 * GET /api/projects/:projectId/tasks/:taskId/variance?baselineId=BL0
 * Single-task variance detail.
 */
app.get('/api/projects/:projectId/tasks/:taskId/variance', asyncHandler(async (req, res) => {
  const scheduler = getProjectOr404(req, res);
  if (!scheduler) return;

  try {
    const variance = scheduler.getTaskVariance(req.params.taskId, req.query.baselineId);
    if (!variance) {
      return res.status(404).json({ error: 'Task not present in the specified baseline' });
    }
    res.json(variance);
  } catch (err) {
    sendError(res, 400, err);
  }
}));

// ============================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================

// 404 for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Central error handler (catches anything asyncHandler passes to next())
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ProjectScheduler API listening on port ${PORT}`);
    console.log(`Health check: GET http://localhost:${PORT}/api/health`);
  });
}

module.exports = app; // Exported for testing (supertest) or embedding in a larger app