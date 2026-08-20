/**
 * ProjectScheduler.js
 * 
 * A comprehensive IT Project Scheduling Engine (MS Project-style)
 * Implements Critical Path Method (CPM), task dependencies, and Gantt data generation
 * 
 * Designed for integration with PMO software systems
 * 
 * @module ProjectScheduler
 */

/**
 * Dependency relationship types (PMBOK standard)
 */
const RELATION_TYPES = {
  FS: 'FS', // Finish-to-Start (most common)
  SS: 'SS', // Start-to-Start
  FF: 'FF', // Finish-to-Finish
  SF: 'SF'  // Start-to-Finish (rare)
};

/**
 * Task status enumeration
 */
const TASK_STATUS = {
  NOT_STARTED: 'Not Started',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  ON_HOLD: 'On Hold',
  DELAYED: 'Delayed'
};

/**
 * ProjectScheduler Class
 * Main engine for managing tasks, dependencies, and schedule calculations
 */
class ProjectScheduler {
  
  /**
   * @param {Object} config - Project configuration
   * @param {string} config.projectId - Unique project identifier
   * @param {string} config.projectName - Project name
   * @param {Date} config.startDate - Project start date
   * @param {Array<number>} config.workingDays - Days of week considered working (0=Sun, 6=Sat), default Mon-Fri
   * @param {Array<Date>} config.holidays - Array of holiday dates to exclude
   */
  constructor(config = {}) {
    this.projectId = config.projectId || `PROJ_${Date.now()}`;
    this.projectName = config.projectName || 'Untitled Project';
    this.startDate = config.startDate ? new Date(config.startDate) : new Date();
    this.workingDays = config.workingDays || [1, 2, 3, 4, 5]; // Mon-Fri default
    this.holidays = (config.holidays || []).map(d => this._normalizeDate(new Date(d)));
    
    this.tasks = new Map();       // task_id -> Task object
    this.dependencies = [];        // Array of dependency objects
    this.resources = new Map();    // resource_id -> Resource object
    this.baselines = new Map();    // baselineId -> { capturedAt, tasks: Map(taskId -> snapshot) }
    this.activeBaselineId = null;
    
    this._scheduleCalculated = false;
    this._criticalPath = [];
  }
  
  // ============================================================
  // TASK MANAGEMENT
  // ============================================================
  
  /**
   * Add a new task to the schedule
   * @param {Object} taskData - Task properties
   * @returns {Object} The created task
   */
  addTask(taskData) {
    const {
      taskId,
      name,
      duration = 1,           // Duration in working days
      percentComplete = 0,
      wbsCode = '',
      resourceIds = [],
      workstream = '',
      status = TASK_STATUS.NOT_STARTED,
      isMilestone = false,
      constraintType = null,   // 'MSO' (Must Start On), 'MFO' (Must Finish On), 'SNET' (Start No Earlier Than), 'FNLT' (Finish No Later Than)
      constraintDate = null,
      notes = ''
    } = taskData;
    
    if (!taskId || !name) {
      throw new Error('Task must have taskId and name');
    }
    
    if (this.tasks.has(taskId)) {
      throw new Error(`Task with ID "${taskId}" already exists`);
    }
    
    const task = {
      taskId,
      name,
      wbsCode,
      duration: isMilestone ? 0 : Math.max(0, duration),
      percentComplete: Math.min(100, Math.max(0, percentComplete)),
      resourceIds,
      workstream,
      status,
      isMilestone,
      constraintType,
      constraintDate: constraintDate ? this._normalizeDate(new Date(constraintDate)) : null,
      notes,
      
      // Actuals (for baseline/variance tracking) - set via recordActual()
      actualStart: taskData.actualStart ? this._normalizeDate(new Date(taskData.actualStart)) : null,
      actualFinish: taskData.actualFinish ? this._normalizeDate(new Date(taskData.actualFinish)) : null,
      
      // Calculated fields (populated by calculateSchedule)
      earlyStart: null,
      earlyFinish: null,
      lateStart: null,
      lateFinish: null,
      totalFloat: null,
      freeFloat: null,
      isCritical: false,
      plannedStart: null,
      plannedFinish: null,
      
      // Predecessor/successor cache (populated during calculation)
      predecessors: [],
      successors: []
    };
    
    this.tasks.set(taskId, task);
    this._scheduleCalculated = false;
    
    return task;
  }
  
  /**
   * Update an existing task
   * @param {string} taskId - Task to update
   * @param {Object} updates - Fields to update
   * @returns {Object} Updated task
   */
  updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }
    
    // Prevent direct mutation of calculated fields
    const protectedFields = ['earlyStart', 'earlyFinish', 'lateStart', 'lateFinish', 
                              'totalFloat', 'freeFloat', 'isCritical', 'predecessors', 'successors'];
    
    Object.keys(updates).forEach(key => {
      if (!protectedFields.includes(key)) {
        task[key] = updates[key];
      }
    });
    
    this._scheduleCalculated = false;
    return task;
  }
  
  /**
   * Delete a task and its associated dependencies
   * @param {string} taskId - Task to delete
   * @returns {boolean} Success status
   */
  deleteTask(taskId) {
    if (!this.tasks.has(taskId)) {
      return false;
    }
    
    this.tasks.delete(taskId);
    
    // Remove dependencies referencing this task
    this.dependencies = this.dependencies.filter(
      dep => dep.taskId !== taskId && dep.predecessorId !== taskId
    );
    
    this._scheduleCalculated = false;
    return true;
  }
  
  /**
   * Get a single task by ID
   * @param {string} taskId 
   * @returns {Object|null}
   */
  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }
  
  /**
   * Get all tasks as an array
   * @returns {Array<Object>}
   */
  getAllTasks() {
    return Array.from(this.tasks.values());
  }
  
  // ============================================================
  // DEPENDENCY MANAGEMENT
  // ============================================================
  
  /**
   * Add a dependency between two tasks
   * @param {Object} depData - Dependency properties
   * @returns {Object} The created dependency
   */
  addDependency(depData) {
    const {
      taskId,              // Successor (child)
      predecessorId,       // Predecessor (parent)
      relationType = RELATION_TYPES.FS,
      lagDays = 0
    } = depData;
    
    if (!this.tasks.has(taskId)) {
      throw new Error(`Task "${taskId}" does not exist`);
    }
    if (!this.tasks.has(predecessorId)) {
      throw new Error(`Predecessor task "${predecessorId}" does not exist`);
    }
    if (taskId === predecessorId) {
      throw new Error('A task cannot depend on itself');
    }
    if (!Object.values(RELATION_TYPES).includes(relationType)) {
      throw new Error(`Invalid relation type: ${relationType}`);
    }
    
    // Check for duplicate
    const exists = this.dependencies.some(
      d => d.taskId === taskId && d.predecessorId === predecessorId
    );
    if (exists) {
      throw new Error('This dependency already exists');
    }
    
    // Check for circular dependency BEFORE adding
    const dependency = { taskId, predecessorId, relationType, lagDays };
    this.dependencies.push(dependency);
    
    if (this._hasCircularDependency()) {
      // Rollback
      this.dependencies.pop();
      throw new Error(
        `Adding this dependency would create a circular reference: ${predecessorId} -> ${taskId}`
      );
    }
    
    this._scheduleCalculated = false;
    return dependency;
  }
  
  /**
   * Remove a dependency
   * @param {string} taskId 
   * @param {string} predecessorId 
   * @returns {boolean}
   */
  removeDependency(taskId, predecessorId) {
    const initialLength = this.dependencies.length;
    this.dependencies = this.dependencies.filter(
      d => !(d.taskId === taskId && d.predecessorId === predecessorId)
    );
    this._scheduleCalculated = false;
    return this.dependencies.length < initialLength;
  }
  
  /**
   * Get all dependencies for a specific task (as successor)
   * @param {string} taskId 
   * @returns {Array<Object>}
   */
  getTaskDependencies(taskId) {
    return this.dependencies.filter(d => d.taskId === taskId);
  }
  
  /**
   * Get all tasks that depend on this task (as predecessor)
   * @param {string} taskId 
   * @returns {Array<Object>}
   */
  getTaskSuccessors(taskId) {
    return this.dependencies.filter(d => d.predecessorId === taskId);
  }
  
  /**
   * Detect circular dependencies using DFS
   * @private
   * @returns {boolean}
   */
  _hasCircularDependency() {
    const visited = new Set();
    const recursionStack = new Set();
    
    const dfs = (taskId) => {
      if (recursionStack.has(taskId)) return true;
      if (visited.has(taskId)) return false;
      
      visited.add(taskId);
      recursionStack.add(taskId);
      
      const successors = this.dependencies
        .filter(d => d.predecessorId === taskId)
        .map(d => d.taskId);
      
      for (const successorId of successors) {
        if (dfs(successorId)) return true;
      }
      
      recursionStack.delete(taskId);
      return false;
    };
    
    for (const taskId of this.tasks.keys()) {
      if (!visited.has(taskId)) {
        if (dfs(taskId)) return true;
      }
    }
    
    return false;
  }
  
  // ============================================================
  // DATE / CALENDAR UTILITIES
  // ============================================================
  
  /**
   * Normalize a date to midnight (strip time component)
   * @private
   */
  _normalizeDate(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  
  /**
   * Check if a date is a working day
   * @private
   */
  _isWorkingDay(date) {
    const day = date.getDay();
    if (!this.workingDays.includes(day)) return false;
    
    const normalized = this._normalizeDate(date).getTime();
    const isHoliday = this.holidays.some(h => h.getTime() === normalized);
    
    return !isHoliday;
  }
  
  /**
   * Add N working days to a date
   * @private
   * @param {Date} startDate 
   * @param {number} workDays - Number of working days to add (can be 0)
   * @returns {Date}
   */
  _addWorkingDays(startDate, workDays) {
    let current = new Date(this._normalizeDate(startDate));
    
    if (workDays === 0) {
      // Move to next working day if current isn't one
      while (!this._isWorkingDay(current)) {
        current.setDate(current.getDate() + 1);
      }
      return current;
    }
    
    let remaining = workDays;
    const direction = workDays > 0 ? 1 : -1;
    remaining = Math.abs(remaining);
    
    while (remaining > 0) {
      current.setDate(current.getDate() + direction);
      if (this._isWorkingDay(current)) {
        remaining--;
      }
    }
    
    return current;
  }
  
  /**
   * Calculate working days between two dates (inclusive)
   * @private
   */
  _workingDaysBetween(startDate, endDate) {
    let count = 0;
    let current = new Date(this._normalizeDate(startDate));
    const end = this._normalizeDate(endDate);
    
    while (current <= end) {
      if (this._isWorkingDay(current)) count++;
      current.setDate(current.getDate() + 1);
    }
    
    return count;
  }
  
  /**
   * Signed working-day offset from one date to another.
   * Positive = toDate is later than fromDate; negative = earlier.
   * @private
   */
  _signedWorkingDaysDiff(fromDate, toDate) {
    const from = this._normalizeDate(new Date(fromDate));
    const to = this._normalizeDate(new Date(toDate));
    
    if (from.getTime() === to.getTime()) return 0;
    
    if (to > from) {
      return this._workingDaysBetween(from, to) - 1;
    }
    return -(this._workingDaysBetween(to, from) - 1);
  }
  
  // ============================================================
  // CRITICAL PATH METHOD (CPM) CALCULATION
  // ============================================================
  
  /**
   * Calculate the full project schedule using Critical Path Method
   * Performs forward pass (early dates) and backward pass (late dates)
   * @returns {Object} Schedule calculation results
   */
  calculateSchedule() {
    if (this.tasks.size === 0) {
      return { success: false, message: 'No tasks to schedule' };
    }
    
    if (this._hasCircularDependency()) {
      return { success: false, message: 'Circular dependency detected in schedule' };
    }
    
    // Build predecessor/successor maps
    this._buildRelationshipCache();
    
    // Get topological order
    const sortedTaskIds = this._topologicalSort();
    
    // Forward Pass - Calculate Early Start / Early Finish
    this._forwardPass(sortedTaskIds);
    
    // Determine project finish date (latest early finish among tasks with no successors)
    const projectFinishDay = Math.max(
      ...Array.from(this.tasks.values()).map(t => t.earlyFinish)
    );
    
    // Backward Pass - Calculate Late Start / Late Finish
    this._backwardPass(sortedTaskIds, projectFinishDay);
    
    // Calculate float and identify critical path
    this._calculateFloat();
    
    // Convert day offsets to actual calendar dates
    this._assignCalendarDates();
    
    this._scheduleCalculated = true;
    
    const projectEndDate = this._addWorkingDays(this.startDate, projectFinishDay - 1);
    
    return {
      success: true,
      projectStartDate: this.startDate,
      projectEndDate: projectEndDate,
      projectDurationDays: projectFinishDay,
      criticalPath: this._criticalPath,
      criticalPathLength: this._criticalPath.length,
      taskCount: this.tasks.size
    };
  }
  
  /**
   * Build predecessor/successor lookup cache on each task
   * @private
   */
  _buildRelationshipCache() {
    this.tasks.forEach(task => {
      task.predecessors = this.dependencies.filter(d => d.taskId === task.taskId);
      task.successors = this.dependencies.filter(d => d.predecessorId === task.taskId);
    });
  }
  
  /**
   * Topological sort of tasks based on dependencies (Kahn's algorithm)
   * @private
   * @returns {Array<string>} Task IDs in dependency order
   */
  _topologicalSort() {
    const inDegree = new Map();
    const adjacency = new Map();
    
    this.tasks.forEach((task, id) => {
      inDegree.set(id, 0);
      adjacency.set(id, []);
    });
    
    this.dependencies.forEach(dep => {
      adjacency.get(dep.predecessorId).push(dep.taskId);
      inDegree.set(dep.taskId, inDegree.get(dep.taskId) + 1);
    });
    
    const queue = [];
    inDegree.forEach((degree, id) => {
      if (degree === 0) queue.push(id);
    });
    
    const sorted = [];
    while (queue.length > 0) {
      const current = queue.shift();
      sorted.push(current);
      
      adjacency.get(current).forEach(neighborId => {
        inDegree.set(neighborId, inDegree.get(neighborId) - 1);
        if (inDegree.get(neighborId) === 0) {
          queue.push(neighborId);
        }
      });
    }
    
    return sorted;
  }
  
  /**
   * Forward pass: calculate Early Start (ES) and Early Finish (EF)
   * Uses day-offset integers (day 1 = project start), converted to dates later
   * @private
   */
  _forwardPass(sortedTaskIds) {
    sortedTaskIds.forEach(taskId => {
      const task = this.tasks.get(taskId);
      
      if (task.predecessors.length === 0) {
        // No predecessors - starts at project start (day 1)
        task.earlyStart = 1;
      } else {
        // Calculate based on each predecessor relationship
        let maxConstraint = 1;
        
        task.predecessors.forEach(dep => {
          const predTask = this.tasks.get(dep.predecessorId);
          let constraint;
          
          switch (dep.relationType) {
            case RELATION_TYPES.FS: // Finish-to-Start
              constraint = predTask.earlyFinish + 1 + dep.lagDays;
              break;
            case RELATION_TYPES.SS: // Start-to-Start
              constraint = predTask.earlyStart + dep.lagDays;
              break;
            case RELATION_TYPES.FF: // Finish-to-Finish
              constraint = predTask.earlyFinish + dep.lagDays - (task.duration - 1);
              break;
            case RELATION_TYPES.SF: // Start-to-Finish
              constraint = predTask.earlyStart + dep.lagDays - (task.duration - 1);
              break;
            default:
              constraint = predTask.earlyFinish + 1 + dep.lagDays;
          }
          
          maxConstraint = Math.max(maxConstraint, constraint);
        });
        
        task.earlyStart = maxConstraint;
      }
      
      // Apply "Start No Earlier Than" constraint if present
      if (task.constraintType === 'SNET' && task.constraintDate) {
        const constraintDay = this._workingDaysBetween(this.startDate, task.constraintDate);
        task.earlyStart = Math.max(task.earlyStart, constraintDay);
      }
      
      task.earlyFinish = task.isMilestone 
        ? task.earlyStart 
        : task.earlyStart + task.duration - 1;
    });
  }
  
  /**
   * Backward pass: calculate Late Start (LS) and Late Finish (LF)
   * @private
   */
  _backwardPass(sortedTaskIds, projectFinishDay) {
    const reverseOrder = [...sortedTaskIds].reverse();
    
    reverseOrder.forEach(taskId => {
      const task = this.tasks.get(taskId);
      
      if (task.successors.length === 0) {
        // No successors - late finish equals project finish
        task.lateFinish = projectFinishDay;
      } else {
        let minConstraint = projectFinishDay;
        
        task.successors.forEach(dep => {
          const succTask = this.tasks.get(dep.taskId);
          let constraint;
          
          switch (dep.relationType) {
            case RELATION_TYPES.FS:
              constraint = succTask.lateStart - 1 - dep.lagDays;
              break;
            case RELATION_TYPES.SS:
              constraint = succTask.lateStart - dep.lagDays + (task.duration - 1);
              break;
            case RELATION_TYPES.FF:
              constraint = succTask.lateFinish - dep.lagDays;
              break;
            case RELATION_TYPES.SF:
              constraint = succTask.lateFinish - dep.lagDays + (task.duration - 1);
              break;
            default:
              constraint = succTask.lateStart - 1 - dep.lagDays;
          }
          
          minConstraint = Math.min(minConstraint, constraint);
        });
        
        task.lateFinish = minConstraint;
      }
      
      task.lateStart = task.isMilestone 
        ? task.lateFinish 
        : task.lateFinish - task.duration + 1;
    });
  }
  
  /**
   * Calculate total float, free float, and identify critical path
   * @private
   */
  _calculateFloat() {
    this._criticalPath = [];
    
    this.tasks.forEach(task => {
      task.totalFloat = task.lateStart - task.earlyStart;
      task.isCritical = task.totalFloat <= 0;
      
      if (task.isCritical) {
        this._criticalPath.push(task.taskId);
      }
      
      // Free float: how much a task can slip without delaying successors
      if (task.successors.length === 0) {
        task.freeFloat = task.totalFloat;
      } else {
        const minSuccessorStart = Math.min(
          ...task.successors.map(dep => {
            const succTask = this.tasks.get(dep.taskId);
            return dep.relationType === RELATION_TYPES.FS 
              ? succTask.earlyStart - dep.lagDays - 1
              : succTask.earlyStart;
          })
        );
        task.freeFloat = Math.max(0, minSuccessorStart - task.earlyFinish);
      }
    });
  }
  
  /**
   * Convert day-offset integers to actual calendar dates
   * @private
   */
  _assignCalendarDates() {
    this.tasks.forEach(task => {
      task.plannedStart = this._addWorkingDays(this.startDate, task.earlyStart - 1);
      task.plannedFinish = task.isMilestone 
        ? task.plannedStart 
        : this._addWorkingDays(this.startDate, task.earlyFinish - 1);
    });
  }
  
  // ============================================================
  // BASELINE & VARIANCE TRACKING
  // ============================================================
  
  /**
   * Capture a baseline snapshot of the current calculated schedule.
   * Call this once the plan is approved (e.g., at project kick-off,
   * or after a re-baseline following an approved change request).
   * 
   * @param {string} baselineId - Unique identifier, e.g. 'BL0', 'BL1'
   * @param {Object} [options]
   * @param {string} [options.label] - Human-readable label, e.g. 'Approved Baseline'
   * @param {boolean} [options.setActive=true] - Make this the active baseline for variance comparisons
   * @returns {Object} The stored baseline snapshot
   */
  captureBaseline(baselineId, options = {}) {
    if (!baselineId) {
      throw new Error('captureBaseline requires a baselineId');
    }
    if (this.baselines.has(baselineId)) {
      throw new Error(`Baseline "${baselineId}" already exists`);
    }
    
    if (!this._scheduleCalculated) {
      this.calculateSchedule();
    }
    
    const taskSnapshots = new Map();
    this.tasks.forEach(task => {
      taskSnapshots.set(task.taskId, {
        name: task.name,
        duration: task.duration,
        plannedStart: task.plannedStart,
        plannedFinish: task.plannedFinish,
        earlyStart: task.earlyStart,
        earlyFinish: task.earlyFinish,
        totalFloat: task.totalFloat,
        isCritical: task.isCritical,
        percentComplete: task.percentComplete
      });
    });
    
    const projectEndDay = Math.max(...this.getAllTasks().map(t => t.earlyFinish));
    const projectEndDate = this._addWorkingDays(this.startDate, projectEndDay - 1);
    
    const baseline = {
      baselineId,
      label: options.label || baselineId,
      capturedAt: new Date(),
      projectStartDate: new Date(this.startDate),
      projectEndDate,
      tasks: taskSnapshots
    };
    
    this.baselines.set(baselineId, baseline);
    
    if (options.setActive !== false) {
      this.activeBaselineId = baselineId;
    }
    
    return baseline;
  }
  
  /**
   * Remove a stored baseline
   * @param {string} baselineId
   * @returns {boolean}
   */
  deleteBaseline(baselineId) {
    const existed = this.baselines.delete(baselineId);
    if (this.activeBaselineId === baselineId) {
      this.activeBaselineId = null;
    }
    return existed;
  }
  
  /**
   * Set which stored baseline is used for variance comparisons
   * @param {string} baselineId
   */
  setActiveBaseline(baselineId) {
    if (!this.baselines.has(baselineId)) {
      throw new Error(`Baseline "${baselineId}" does not exist`);
    }
    this.activeBaselineId = baselineId;
  }
  
  /**
   * List all stored baselines (metadata only, no task detail)
   * @returns {Array<Object>}
   */
  listBaselines() {
    return Array.from(this.baselines.values()).map(b => ({
      baselineId: b.baselineId,
      label: b.label,
      capturedAt: b.capturedAt,
      projectStartDate: this._formatDate(b.projectStartDate),
      projectEndDate: this._formatDate(b.projectEndDate),
      taskCount: b.tasks.size,
      isActive: b.baselineId === this.activeBaselineId
    }));
  }
  
  /**
   * Record actual start/finish/progress for a task. This is the normal way
   * to feed real-world progress into the tracker as work happens.
   * 
   * @param {string} taskId
   * @param {Object} actuals
   * @param {Date|string} [actuals.actualStart]
   * @param {Date|string} [actuals.actualFinish]
   * @param {number} [actuals.percentComplete]
   * @param {string} [actuals.status]
   * @returns {Object} Updated task
   */
  recordActual(taskId, actuals = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }
    
    const updates = {};
    if (actuals.actualStart) updates.actualStart = this._normalizeDate(new Date(actuals.actualStart));
    if (actuals.actualFinish) updates.actualFinish = this._normalizeDate(new Date(actuals.actualFinish));
    if (actuals.percentComplete !== undefined) updates.percentComplete = actuals.percentComplete;
    if (actuals.status) updates.status = actuals.status;
    
    // Auto-complete: if percentComplete hits 100 and no actualFinish given, don't assume -
    // leave it to the PMO tool to set actualFinish explicitly (avoids guessing a date).
    
    return this.updateTask(taskId, updates);
  }
  
  /**
   * Compute schedule variance for a single task against a baseline.
   * Uses actual dates where recorded, otherwise falls back to the
   * current forecast (recalculated planned dates).
   * 
   * @param {string} taskId
   * @param {string} [baselineId] - Defaults to the active baseline
   * @returns {Object} Variance detail
   */
  getTaskVariance(taskId, baselineId = this.activeBaselineId) {
    if (!baselineId) {
      throw new Error('No baseline specified and no active baseline set');
    }
    const baseline = this.baselines.get(baselineId);
    if (!baseline) {
      throw new Error(`Baseline "${baselineId}" does not exist`);
    }
    
    const baseTask = baseline.tasks.get(taskId);
    if (!baseTask) {
      return null; // Task didn't exist at baseline capture time (added later)
    }
    
    if (!this._scheduleCalculated) {
      this.calculateSchedule();
    }
    const currentTask = this.tasks.get(taskId);
    if (!currentTask) {
      return {
        taskId,
        name: baseTask.name,
        deleted: true,
        message: 'Task existed in baseline but has since been deleted'
      };
    }
    
    const comparisonStart = currentTask.actualStart || currentTask.plannedStart;
    const comparisonFinish = currentTask.actualFinish || currentTask.plannedFinish;
    
    const startVarianceDays = this._signedWorkingDaysDiff(baseTask.plannedStart, comparisonStart);
    const finishVarianceDays = this._signedWorkingDaysDiff(baseTask.plannedFinish, comparisonFinish);
    const durationVarianceDays = currentTask.duration - baseTask.duration;
    const completionVariancePercent = Math.round(
      (currentTask.percentComplete - baseTask.percentComplete) * 10
    ) / 10;
    
    let scheduleStatus;
    if (currentTask.actualFinish) {
      scheduleStatus = finishVarianceDays > 0 ? 'Completed Late'
        : finishVarianceDays < 0 ? 'Completed Early'
        : 'Completed On Time';
    } else {
      scheduleStatus = finishVarianceDays > 0 ? 'Behind Schedule'
        : finishVarianceDays < 0 ? 'Ahead of Schedule'
        : 'On Track';
    }
    
    return {
      taskId,
      name: currentTask.name,
      baseline: {
        plannedStart: this._formatDate(baseTask.plannedStart),
        plannedFinish: this._formatDate(baseTask.plannedFinish),
        duration: baseTask.duration,
        wasCritical: baseTask.isCritical
      },
      current: {
        plannedStart: this._formatDate(currentTask.plannedStart),
        plannedFinish: this._formatDate(currentTask.plannedFinish),
        actualStart: this._formatDate(currentTask.actualStart),
        actualFinish: this._formatDate(currentTask.actualFinish),
        duration: currentTask.duration,
        percentComplete: currentTask.percentComplete,
        isCritical: currentTask.isCritical
      },
      variance: {
        startVarianceDays,
        finishVarianceDays,
        durationVarianceDays,
        completionVariancePercent
      },
      scheduleStatus,
      criticalityChanged: baseTask.isCritical !== currentTask.isCritical,
      becameCritical: !baseTask.isCritical && currentTask.isCritical,
      droppedFromCriticalPath: baseTask.isCritical && !currentTask.isCritical
    };
  }
  
  /**
   * Generate a full project-level variance report against a baseline.
   * This is the primary method for a PMO dashboard "baseline vs actual" view.
   * 
   * @param {string} [baselineId] - Defaults to the active baseline
   * @returns {Object} Full variance report
   */
  getVarianceReport(baselineId = this.activeBaselineId) {
    if (!baselineId) {
      throw new Error('No baseline specified and no active baseline set');
    }
    const baseline = this.baselines.get(baselineId);
    if (!baseline) {
      throw new Error(`Baseline "${baselineId}" does not exist`);
    }
    
    if (!this._scheduleCalculated) {
      this.calculateSchedule();
    }
    
    const taskVariances = Array.from(baseline.tasks.keys())
      .map(taskId => this.getTaskVariance(taskId, baselineId))
      .filter(v => v !== null);
    
    const currentProjectEndDay = Math.max(...this.getAllTasks().map(t => t.earlyFinish));
    const currentForecastEnd = this._addWorkingDays(this.startDate, currentProjectEndDay - 1);
    const projectFinishVarianceDays = this._signedWorkingDaysDiff(
      baseline.projectEndDate,
      currentForecastEnd
    );
    
    const behindCount = taskVariances.filter(v => !v.deleted && v.variance.finishVarianceDays > 0 && !v.current.actualFinish).length;
    const aheadCount = taskVariances.filter(v => !v.deleted && v.variance.finishVarianceDays < 0 && !v.current.actualFinish).length;
    const onTrackCount = taskVariances.filter(v => !v.deleted && v.variance.finishVarianceDays === 0 && !v.current.actualFinish).length;
    const newlyCriticalTasks = taskVariances.filter(v => !v.deleted && v.becameCritical).map(v => v.taskId);
    const droppedCriticalTasks = taskVariances.filter(v => !v.deleted && v.droppedFromCriticalPath).map(v => v.taskId);
    const deletedTasks = taskVariances.filter(v => v.deleted).map(v => v.taskId);
    const newTasksSinceBaseline = this.getAllTasks()
      .filter(t => !baseline.tasks.has(t.taskId))
      .map(t => t.taskId);
    
    return {
      baselineId,
      baselineLabel: baseline.label,
      baselineCapturedAt: baseline.capturedAt,
      project: {
        baselineStartDate: this._formatDate(baseline.projectStartDate),
        baselineEndDate: this._formatDate(baseline.projectEndDate),
        currentForecastEndDate: this._formatDate(currentForecastEnd),
        finishVarianceDays: projectFinishVarianceDays,
        status: projectFinishVarianceDays > 0 ? 'Behind Baseline'
          : projectFinishVarianceDays < 0 ? 'Ahead of Baseline'
          : 'On Baseline'
      },
      summary: {
        totalTasksTracked: taskVariances.length,
        behindSchedule: behindCount,
        aheadOfSchedule: aheadCount,
        onTrack: onTrackCount,
        newlyCriticalTasks,
        droppedFromCriticalPath: droppedCriticalTasks,
        tasksDeletedSinceBaseline: deletedTasks,
        newTasksSinceBaseline
      },
      tasks: taskVariances
    };
  }
  
  // ============================================================
  // OUTPUT / EXPORT METHODS
  // ============================================================
  
  /**
   * Generate Gantt chart-ready data structure
   * @returns {Array<Object>}
   */
  getGanttData() {
    if (!this._scheduleCalculated) {
      this.calculateSchedule();
    }
    
    return this.getAllTasks()
      .sort((a, b) => a.earlyStart - b.earlyStart)
      .map(task => ({
        id: task.taskId,
        name: task.name,
        wbsCode: task.wbsCode,
        start: this._formatDate(task.plannedStart),
        end: this._formatDate(task.plannedFinish),
        duration: task.duration,
        progress: task.percentComplete,
        isCritical: task.isCritical,
        isMilestone: task.isMilestone,
        totalFloat: task.totalFloat,
        status: task.status,
        dependencies: task.predecessors.map(p => ({
          from: p.predecessorId,
          type: p.relationType,
          lag: p.lagDays
        }))
      }));
  }
  
  /**
   * Get summary statistics for the project
   * @returns {Object}
   */
  getProjectSummary() {
    if (!this._scheduleCalculated) {
      this.calculateSchedule();
    }
    
    const tasks = this.getAllTasks();
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === TASK_STATUS.COMPLETED).length;
    const criticalTasks = tasks.filter(t => t.isCritical).length;
    const overallProgress = totalTasks > 0
      ? tasks.reduce((sum, t) => sum + t.percentComplete, 0) / totalTasks
      : 0;
    
    const projectEndDay = Math.max(...tasks.map(t => t.earlyFinish));
    const projectEndDate = this._addWorkingDays(this.startDate, projectEndDay - 1);
    
    return {
      projectId: this.projectId,
      projectName: this.projectName,
      startDate: this._formatDate(this.startDate),
      endDate: this._formatDate(projectEndDate),
      durationDays: projectEndDay,
      totalTasks,
      completedTasks,
      inProgressTasks: tasks.filter(t => t.status === TASK_STATUS.IN_PROGRESS).length,
      criticalTasks,
      overallProgressPercent: Math.round(overallProgress * 10) / 10,
      milestones: tasks.filter(t => t.isMilestone).length
    };
  }
  
  /**
   * Export complete schedule data (for PMO integration)
   * @returns {Object}
   */
  exportSchedule() {
    if (!this._scheduleCalculated) {
      this.calculateSchedule();
    }
    
    return {
      project: {
        projectId: this.projectId,
        projectName: this.projectName,
        startDate: this._formatDate(this.startDate)
      },
      summary: this.getProjectSummary(),
      tasks: this.getAllTasks().map(task => ({
        taskId: task.taskId,
        name: task.name,
        wbsCode: task.wbsCode,
        duration: task.duration,
        percentComplete: task.percentComplete,
        status: task.status,
        isMilestone: task.isMilestone,
        workstream: task.workstream,
        plannedStart: this._formatDate(task.plannedStart),
        plannedFinish: this._formatDate(task.plannedFinish),
        earlyStart: task.earlyStart,
        earlyFinish: task.earlyFinish,
        lateStart: task.lateStart,
        lateFinish: task.lateFinish,
        totalFloat: task.totalFloat,
        freeFloat: task.freeFloat,
        isCritical: task.isCritical,
        resourceIds: task.resourceIds,
        notes: task.notes
      })),
      dependencies: this.dependencies.map(dep => ({
        taskId: dep.taskId,
        predecessorId: dep.predecessorId,
        relationType: dep.relationType,
        lagDays: dep.lagDays
      })),
      criticalPath: this._criticalPath
    };
  }
  
  /**
   * Import schedule data (e.g., from JSON/CSV parsed data)
   * @param {Object} data - Data matching exportSchedule() structure
   */
  importSchedule(data) {
    this.tasks.clear();
    this.dependencies = [];
    
    if (data.project) {
      this.projectId = data.project.projectId || this.projectId;
      this.projectName = data.project.projectName || this.projectName;
      if (data.project.startDate) {
        this.startDate = new Date(data.project.startDate);
      }
    }
    
    (data.tasks || []).forEach(t => {
      this.addTask({
        taskId: t.taskId,
        name: t.name,
        wbsCode: t.wbsCode,
        duration: t.duration,
        percentComplete: t.percentComplete,
        status: t.status,
        isMilestone: t.isMilestone,
        workstream: t.workstream,
        resourceIds: t.resourceIds,
        notes: t.notes
      });
    });
    
    (data.dependencies || []).forEach(d => {
      this.addDependency({
        taskId: d.taskId,
        predecessorId: d.predecessorId,
        relationType: d.relationType,
        lagDays: d.lagDays
      });
    });
    
    this._scheduleCalculated = false;
  }
  
  /**
   * Format date as YYYY-MM-DD string
   * @private
   */
  _formatDate(date) {
    if (!date) return null;
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  /**
   * Validate the entire schedule for common issues
   * @returns {Object} Validation results with warnings/errors
   */
  validateSchedule() {
    const errors = [];
    const warnings = [];
    
    if (this.tasks.size === 0) {
      errors.push('Project has no tasks');
    }
    
    if (this._hasCircularDependency()) {
      errors.push('Circular dependency detected');
    }
    
    // Orphan tasks (no dependencies at all) - just a warning
    this.tasks.forEach(task => {
      const hasPredecessor = this.dependencies.some(d => d.taskId === task.taskId);
      const hasSuccessor = this.dependencies.some(d => d.predecessorId === task.taskId);
      
      if (!hasPredecessor && !hasSuccessor && this.tasks.size > 1) {
        warnings.push(`Task "${task.taskId}" (${task.name}) has no dependencies - isolated task`);
      }
      
      if (task.duration === 0 && !task.isMilestone) {
        warnings.push(`Task "${task.taskId}" has zero duration but is not marked as milestone`);
      }
      
      if (task.percentComplete === 100 && task.status !== TASK_STATUS.COMPLETED) {
        warnings.push(`Task "${task.taskId}" is 100% complete but status is "${task.status}"`);
      }
    });
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}

// ============================================================
// FACTORY FUNCTION (as requested - functional interface)
// ============================================================

/**
 * Factory function to create a project scheduler instance
 * Provides a simpler functional interface for PMO integration
 * 
 * @param {Object} config - Project configuration
 * @returns {ProjectScheduler} A configured scheduler instance
 * 
 * @example
 * const scheduler = createProjectSchedule({
 *   projectId: 'PROJ001',
 *   projectName: 'CRM Implementation',
 *   startDate: '2026-01-05'
 * });
 * 
 * scheduler.addTask({ taskId: 'T001', name: 'Requirements', duration: 10 });
 * scheduler.addTask({ taskId: 'T002', name: 'Design', duration: 15 });
 * scheduler.addDependency({ taskId: 'T002', predecessorId: 'T001' });
 * 
 * const result = scheduler.calculateSchedule();
 * console.log(scheduler.exportSchedule());
 */
function createProjectSchedule(config) {
  return new ProjectScheduler(config);
}

// ============================================================
// EXPORTS (supports both Node.js/CommonJS and ES Modules)
// ============================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { 
    ProjectScheduler, 
    createProjectSchedule, 
    RELATION_TYPES, 
    TASK_STATUS 
  };
}

if (typeof window !== 'undefined') {
  window.ProjectScheduler = ProjectScheduler;
  window.createProjectSchedule = createProjectSchedule;
}