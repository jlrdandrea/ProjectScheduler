# ProjectScheduler
Project Scheduler 
A complete Critical Path Method (CPM) scheduling engine in JavaScript, structured as a ProjectScheduler class plus a createProjectSchedule() factory function for a simpler functional interface — ready to integrate into your PMO software.

Core Capabilities

Task Management

addTask(), updateTask(), deleteTask(), getTask(), getAllTasks()
Supports milestones (zero duration), WBS codes, resource assignment, status tracking
Constraint types (SNET, MSO, etc.) for fixed dates

Dependency Management

All 4 PMBOK relationship types: FS, SS, FF, SF with lag/lead days
Automatic circular dependency detection (DFS-based) — rejects invalid dependencies before they corrupt the schedule

Calendar Engine

Configurable working days (default Mon–Fri) and holiday exclusion list
Converts day-offsets to real calendar dates, skipping non-working days

Critical Path Method (the core algorithm)

Forward pass: Early Start / Early Finish via topological sort (Kahn's algorithm)
Backward pass: Late Start / Late Finish
Float calculation: Total float and free float per task
Critical path identification: tasks with zero float

PMO Integration Points

getGanttData() — ready-to-render Gantt structure (start/end/progress/critical flag/dependencies)
exportSchedule() — full JSON payload (tasks, dependencies, summary, critical path) — this is what you'd POST to your PMO backend
importSchedule() — reload from JSON (e.g., from your database)
getProjectSummary() — KPIs: progress %, critical task count, milestones, etc.
validateSchedule() — pre-flight checks (orphan tasks, zero-duration non-milestones, status/progress mismatches)
Example usage
javascript
const scheduler = createProjectSchedule({
  projectId: 'PROJ001',
  projectName: 'CRM Implementation',
  startDate: '2026-01-05'
});

scheduler.addTask({ taskId: 'T001', name: 'Requirements', duration: 10 });
scheduler.addTask({ taskId: 'T002', name: 'Design', duration: 15 });
scheduler.addDependency({ taskId: 'T002', predecessorId: 'T001', relationType: 'FS', lagDays: 0 });

const result = scheduler.calculateSchedule();
console.log(result.criticalPath);          // ['T001', 'T002']
console.log(scheduler.getGanttData());     // Gantt-ready rows
console.log(scheduler.exportSchedule());   // Full payload for your PMO API
Integration notes for your PMO system
Works in both Node.js and browser (CommonJS module.exports + window global)
Stateless-friendly: importSchedule() / exportSchedule() round-trip cleanly with a database or API
All calculated fields (early/late start/finish, float, critical flag) are protected from direct mutation in updateTask() — they're only ever set by calculateSchedule(), keeping data integrity
Since your existing Shiny apps export CSV with task_id/predecessor_task_id/relation_type/lag_days, this engine's dependency schema maps directly onto that format for easy interop
