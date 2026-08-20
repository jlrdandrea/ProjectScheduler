# ProjectScheduler.js

A dependency-free, MS Project–style scheduling engine for JavaScript, implementing the **Critical Path Method (CPM)**, baseline/variance tracking, and schedule-risk sensitivity analysis. Built for integration into PMO software.

Two files:

| File | Purpose |
|---|---|
| `ProjectScheduler.js` | The core scheduling engine (no dependencies, runs in Node.js or the browser) |
| `server.js` | Optional REST API wrapper around the engine (Express) |

---

## Table of Contents

- [Feature Overview](#feature-overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [API Reference — ProjectScheduler class](#api-reference--projectscheduler-class)
  - [1. Task Management](#1-task-management)
  - [2. Dependency Management](#2-dependency-management)
  - [3. Schedule Calculation (CPM)](#3-schedule-calculation-cpm)
  - [4. Baseline & Variance Tracking](#4-baseline--variance-tracking)
  - [5. Sensitivity Analysis & Schedule Risk Simulation](#5-sensitivity-analysis--schedule-risk-simulation)
  - [6. Output / Export](#6-output--export)
- [REST API (server.js)](#rest-api-serverjs)
- [Data Model Reference](#data-model-reference)
- [Integration Notes for PMO Software](#integration-notes-for-pmo-software)
- [License](#license)

---

## Feature Overview

The engine was built up in layers. Each layer is independent — use only what you need.

| Layer | What it adds |
|---|---|
| **Core CPM engine** | Tasks, dependencies (FS/SS/FF/SF + lag), working-day calendar, forward/backward pass, float, critical path |
| **Output/export** | Gantt-ready data, project summary, JSON export/import, schedule validation |
| **Baseline & variance** | Snapshot an approved plan, record actuals, compare forecast vs. baseline (schedule variance in working days, criticality drift) |
| **Sensitivity analysis** | Tornado diagram (one-at-a-time duration sensitivity) + Monte Carlo schedule risk simulation with per-task criticality index |
| **REST API** (optional) | Express wrapper exposing every capability above over HTTP, for integration with any PMO frontend/backend |

---

## Installation

### Core engine only

No dependencies. Just drop `ProjectScheduler.js` into your project.

```bash
# Node.js / CommonJS
const { createProjectSchedule, ProjectScheduler, RELATION_TYPES, TASK_STATUS } = require('./ProjectScheduler');
```

```html
<!-- Browser -->
<script src="ProjectScheduler.js"></script>
<script>
  const scheduler = createProjectSchedule({ projectId: 'PROJ001' });
</script>
```

### With the REST API

```bash
npm install express cors
node server.js
# API listening on http://localhost:3000
```

---

## Quick Start

```javascript
const { createProjectSchedule } = require('./ProjectScheduler');

// 1. Create a project
const scheduler = createProjectSchedule({
  projectId: 'PROJ001',
  projectName: 'CRM Implementation',
  startDate: '2026-01-05',
  workingDays: [1, 2, 3, 4, 5],      // Mon–Fri (default)
  holidays: ['2026-01-26']            // dates to exclude
});

// 2. Add tasks
scheduler.addTask({ taskId: 'T001', name: 'Requirements', duration: 10 });
scheduler.addTask({ taskId: 'T002', name: 'Design', duration: 15 });
scheduler.addTask({ taskId: 'T003', name: 'Build', duration: 20 });
scheduler.addTask({ taskId: 'T004', name: 'Go-Live', duration: 0, isMilestone: true });

// 3. Add dependencies
scheduler.addDependency({ taskId: 'T002', predecessorId: 'T001' });                 // FS, 0 lag (default)
scheduler.addDependency({ taskId: 'T003', predecessorId: 'T002' });
scheduler.addDependency({ taskId: 'T004', predecessorId: 'T003', lagDays: 2 });

// 4. Calculate the schedule (CPM)
const result = scheduler.calculateSchedule();
console.log(result.projectEndDate, result.criticalPath);

// 5. Get Gantt-ready data
console.log(scheduler.getGanttData());

// 6. Export everything (for saving to your database)
console.log(scheduler.exportSchedule());
```

---

## Core Concepts

- **Day offsets vs. calendar dates.** Internally, CPM math runs on integer working-day offsets (day 1 = project start). These are converted to real calendar dates (`plannedStart`/`plannedFinish`) after the pass, skipping weekends/holidays per your calendar config.
- **Working-day calendar.** Configure `workingDays` (array of `0`–`6`, `0` = Sunday) and `holidays` (array of dates) per project.
- **Milestones.** Tasks with `isMilestone: true` always have `duration: 0`.
- **Relationship types** (PMBOK standard): `FS` (Finish-to-Start, default), `SS` (Start-to-Start), `FF` (Finish-to-Finish), `SF` (Start-to-Finish). All support `lagDays` (positive = lag, negative = lead).
- **Circular dependencies are rejected at insert time** — `addDependency()` throws before corrupting the schedule.
- **Calculated fields are read-only.** `earlyStart`, `earlyFinish`, `lateStart`, `lateFinish`, `totalFloat`, `freeFloat`, `isCritical` are only ever set by `calculateSchedule()` — attempting to set them via `updateTask()` is silently ignored.

---

## API Reference — ProjectScheduler class

### 1. Task Management

```javascript
scheduler.addTask({
  taskId: 'T001',              // required, unique
  name: 'Requirements',        // required
  duration: 10,                // working days (ignored if isMilestone)
  wbsCode: '1.1',
  percentComplete: 0,
  resourceIds: ['R001'],
  workstream: 'Analysis',
  status: 'Not Started',       // TASK_STATUS enum
  isMilestone: false,
  constraintType: null,        // 'SNET' supported (Start No Earlier Than)
  constraintDate: null,
  notes: '',
  durationOptimistic: null,    // for sensitivity analysis / simulation
  durationPessimistic: null
});

scheduler.updateTask('T001', { percentComplete: 50, status: 'In Progress' });
scheduler.deleteTask('T001');       // also removes dependencies referencing it
scheduler.getTask('T001');
scheduler.getAllTasks();
```

### 2. Dependency Management

```javascript
scheduler.addDependency({
  taskId: 'T002',              // successor (child)
  predecessorId: 'T001',       // predecessor (parent)
  relationType: 'FS',          // FS | SS | FF | SF
  lagDays: 0
});

scheduler.removeDependency('T002', 'T001');
scheduler.getTaskDependencies('T002');  // deps where T002 is the successor
scheduler.getTaskSuccessors('T001');    // deps where T001 is the predecessor
```

### 3. Schedule Calculation (CPM)

```javascript
const result = scheduler.calculateSchedule();
// {
//   success: true,
//   projectStartDate, projectEndDate, projectDurationDays,
//   criticalPath: ['T001','T002','T003','T004'],
//   criticalPathLength, taskCount
// }
```

Call this any time after adding/editing tasks or dependencies — most other methods call it automatically if the schedule is stale.

### 4. Baseline & Variance Tracking

Lock an approved plan, then track drift as real progress comes in.

```javascript
// Lock the approved plan
scheduler.captureBaseline('BL0', { label: 'Approved Baseline', setActive: true });

// ... weeks later, record real progress ...
scheduler.recordActual('T001', {
  actualStart: '2026-01-06',
  actualFinish: '2026-01-21',
  percentComplete: 100,
  status: 'Completed'
});

// Project-level report
const report = scheduler.getVarianceReport();       // uses active baseline by default
console.log(report.project.status);                  // 'Behind Baseline' | 'Ahead of Baseline' | 'On Baseline'
console.log(report.summary.behindSchedule);           // count of slipping tasks
console.log(report.summary.newlyCriticalTasks);        // tasks that became critical since baseline

// Single-task detail
scheduler.getTaskVariance('T001');
// { variance: { startVarianceDays, finishVarianceDays, ... }, scheduleStatus: 'Completed Early', ... }

// Managing multiple baselines (e.g. after a re-baseline / change request)
scheduler.captureBaseline('BL1', { label: 'Re-baseline after CR-004' });
scheduler.setActiveBaseline('BL1');
scheduler.listBaselines();
scheduler.deleteBaseline('BL0');
```

### 5. Sensitivity Analysis & Schedule Risk Simulation

Set three-point estimates on the tasks with the most uncertainty:

```javascript
scheduler.updateTask('T003', { durationOptimistic: 15, durationPessimistic: 30 });
```

**Tornado diagram** (deterministic, one-at-a-time):

```javascript
const tornado = scheduler.getSensitivityAnalysis({ topN: 10, defaultVariabilityPercent: 20 });
// {
//   baselineProjectDurationDays: 45,
//   tornado: [
//     { taskId: 'T003', name: 'Build', swingDays: 15, lowImpactDays: -5, highImpactDays: 10, ... },
//     ...
//   ]
// }
```

Tasks without explicit `durationOptimistic`/`durationPessimistic` fall back to ±`defaultVariabilityPercent` of their current duration.

**Monte Carlo schedule risk simulation** (probabilistic, all tasks together):

```javascript
const sim = scheduler.runScheduleRiskSimulation({ iterations: 5000 });
// {
//   iterations: 5000,
//   projectDurationDays: { mean, p50, p80, p95, min, max },
//   criticalityIndex: [
//     { taskId: 'T003', name: 'Build', criticalityIndexPercent: 87.4 },
//     ...  // % of iterations each task landed on the critical path
//   ]
// }
```

Use the tornado chart to see *which tasks swing the schedule most*, and the criticality index to see *which tasks are most often the actual bottleneck* — high-swing **and** high-criticality tasks are the ones most worth actively managing. The simulation restores all original durations automatically when finished.

### 6. Output / Export

```javascript
scheduler.getGanttData();       // array of { id, name, start, end, isCritical, dependencies, ... }
scheduler.getProjectSummary();  // KPIs: progress %, critical task count, milestones, etc.
scheduler.exportSchedule();     // full JSON payload — tasks, dependencies, baselines, critical path
scheduler.importSchedule(data); // restore from a payload matching exportSchedule()'s shape
scheduler.validateSchedule();   // { isValid, errors, warnings } — orphan tasks, zero-duration non-milestones, etc.
```

`exportSchedule()` is the primary integration point — persist its output to your PMO database, and `importSchedule()` to restore it.

---

## REST API (server.js)

An Express wrapper exposing the full engine over HTTP. Projects are held in memory by default — swap the `Map` in `server.js` for your database layer, using `exportSchedule()`/`importSchedule()` as the persistence contract.

```bash
npm install express cors
node server.js
# Health check: GET http://localhost:3000/api/health
```

### Projects

| Method | Route | Body / Query | Description |
|---|---|---|---|
| POST | `/api/projects` | `{ projectId, projectName, startDate, workingDays?, holidays? }` | Create a project |
| GET | `/api/projects` | — | List all projects (summaries) |
| GET | `/api/projects/:projectId` | — | Full export (tasks, deps, critical path, baselines) |
| PUT | `/api/projects/:projectId` | `{ projectName?, startDate?, workingDays?, holidays? }` | Update project settings |
| DELETE | `/api/projects/:projectId` | — | Delete project |
| POST | `/api/projects/:projectId/import` | `exportSchedule()`-shaped payload | Restore a project from saved data |

### Tasks

| Method | Route | Description |
|---|---|---|
| GET | `/api/projects/:projectId/tasks` | List tasks |
| GET | `/api/projects/:projectId/tasks/:taskId` | Get one task |
| POST | `/api/projects/:projectId/tasks` | Add task |
| PUT | `/api/projects/:projectId/tasks/:taskId` | Update task |
| DELETE | `/api/projects/:projectId/tasks/:taskId` | Delete task |
| POST | `/api/projects/:projectId/tasks/:taskId/actuals` | Record actual start/finish/% complete |

### Dependencies

| Method | Route | Description |
|---|---|---|
| GET | `/api/projects/:projectId/dependencies` | List dependencies |
| POST | `/api/projects/:projectId/dependencies` | Add dependency |
| DELETE | `/api/projects/:projectId/dependencies` | Remove (body/query: `taskId`, `predecessorId`) |

### Schedule Engine

| Method | Route | Description |
|---|---|---|
| POST | `/api/projects/:projectId/calculate` | Run CPM forward/backward pass |
| GET | `/api/projects/:projectId/gantt` | Gantt-ready rows |
| GET | `/api/projects/:projectId/summary` | Project KPIs |
| GET | `/api/projects/:projectId/validate` | Pre-flight checks |

### Baselines & Variance

| Method | Route | Description |
|---|---|---|
| GET | `/api/projects/:projectId/baselines` | List baselines |
| POST | `/api/projects/:projectId/baselines` | Capture baseline (`{ baselineId, label?, setActive? }`) |
| PUT | `/api/projects/:projectId/baselines/active` | Switch active baseline (`{ baselineId }`) |
| DELETE | `/api/projects/:projectId/baselines/:baselineId` | Delete a baseline |
| GET | `/api/projects/:projectId/variance?baselineId=` | Full project variance report |
| GET | `/api/projects/:projectId/tasks/:taskId/variance?baselineId=` | Single-task variance |

### Sensitivity & Simulation

| Method | Route | Description |
|---|---|---|
| GET | `/api/projects/:projectId/sensitivity?topN=&defaultVariabilityPercent=` | Tornado diagram data |
| POST | `/api/projects/:projectId/simulate` | Monte Carlo simulation (`{ iterations? }`) |

### End-to-end example

```bash
curl -X POST localhost:3000/api/projects -H "Content-Type: application/json" \
  -d '{"projectId":"PROJ001","projectName":"CRM Implementation","startDate":"2026-01-05"}'

curl -X POST localhost:3000/api/projects/PROJ001/tasks -H "Content-Type: application/json" \
  -d '{"taskId":"T001","name":"Requirements","duration":10}'

curl -X POST localhost:3000/api/projects/PROJ001/tasks -H "Content-Type: application/json" \
  -d '{"taskId":"T002","name":"Design","duration":15}'

curl -X POST localhost:3000/api/projects/PROJ001/dependencies -H "Content-Type: application/json" \
  -d '{"taskId":"T002","predecessorId":"T001"}'

curl -X POST localhost:3000/api/projects/PROJ001/calculate

curl localhost:3000/api/projects/PROJ001/gantt

curl -X POST localhost:3000/api/projects/PROJ001/baselines -H "Content-Type: application/json" \
  -d '{"baselineId":"BL0","label":"Approved Baseline"}'

curl localhost:3000/api/projects/PROJ001/variance
```

---

## Data Model Reference

### Task object (as returned by `getTask()` / `getAllTasks()`)

| Field | Type | Notes |
|---|---|---|
| `taskId` | string | Unique |
| `name` | string | |
| `wbsCode` | string | |
| `duration` | number | Working days; `0` for milestones |
| `durationOptimistic` / `durationPessimistic` | number \| null | For sensitivity/simulation |
| `percentComplete` | number | 0–100 |
| `resourceIds` | string[] | |
| `workstream` | string | |
| `status` | string | See `TASK_STATUS` |
| `isMilestone` | boolean | |
| `constraintType` / `constraintDate` | string \| null | `SNET` supported |
| `actualStart` / `actualFinish` | Date \| null | Set via `recordActual()` |
| `earlyStart`, `earlyFinish`, `lateStart`, `lateFinish` | number | Day offsets (read-only, CPM output) |
| `totalFloat`, `freeFloat` | number | Read-only |
| `isCritical` | boolean | Read-only |
| `plannedStart`, `plannedFinish` | Date | Calendar dates (read-only) |
| `predecessors`, `successors` | array | Cached dependency lookups (read-only) |

### Dependency object

| Field | Type |
|---|---|
| `taskId` | string (successor) |
| `predecessorId` | string (predecessor) |
| `relationType` | `'FS'` \| `'SS'` \| `'FF'` \| `'SF'` |
| `lagDays` | number (negative = lead time) |

### Enums

```javascript
const RELATION_TYPES = { FS: 'FS', SS: 'SS', FF: 'FF', SF: 'SF' };
const TASK_STATUS = {
  NOT_STARTED: 'Not Started',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  ON_HOLD: 'On Hold',
  DELAYED: 'Delayed'
};
```

---

## Integration Notes for PMO Software

1. **Persistence contract:** `exportSchedule()` / `importSchedule()` round-trip is the intended boundary between this engine and your database — store the export payload as JSON per project.
2. **Multi-project:** the REST API's in-memory `Map` (`projectId -> ProjectScheduler`) is a placeholder — replace with your data layer, loading a scheduler instance via `importSchedule()` per request or caching instances as needed.
3. **CSV interoperability:** the dependency schema (`taskId` / `predecessorId` / `relationType` / `lagDays`) matches common PM CSV export formats (e.g. `task_id` / `predecessor_task_id` / `relation_type` / `lag_days`), making it straightforward to bulk-import from spreadsheet-based schedules.
4. **Runs anywhere:** `ProjectScheduler.js` has zero dependencies and exports via both CommonJS (`module.exports`) and a browser global (`window.ProjectScheduler`) — usable in a Node backend, a browser-based Gantt UI, or both.
5. **Performance note:** `runScheduleRiskSimulation()` recalculates the full CPM network per iteration. This is fine for typical project sizes at the default 5,000 iterations, but very large task counts should reduce `iterations` or run simulations server-side/off the main thread.

---

## License

Add your organisation's license terms here before publishing.
