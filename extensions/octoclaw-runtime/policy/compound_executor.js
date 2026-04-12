import {
  validateCompoundPlan,
  scheduleCompoundPlan,
  evaluateGuard,
  validateCompoundExecution,
} from "./compound_plan.js";

const LEDGER_SCHEMA_VERSION = "octoclaw.execution_ledger/v1";

function normalizeText(value) {
  return String(value || "").trim();
}

/**
 * Creates an empty execution ledger from a validated compound plan.
 *
 * @param {object} plan - A normalized compound plan object.
 * @returns {object} Execution ledger with all items in "pending" status.
 */
export function createExecutionLedger(plan) {
  const items = new Map();

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return {
      plan_id: "",
      schema_version: LEDGER_SCHEMA_VERSION,
      items,
      started_at: null,
      completed_at: null,
    };
  }

  const planId = normalizeText(plan.plan_id) || "";
  const workItems = Array.isArray(plan.work_items) ? plan.work_items : [];

  for (const item of workItems) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = normalizeText(item.id);
    if (!id) continue;

    items.set(id, {
      status: "pending",
      materialization_facts: null,
      materialization_failed: false,
      result: null,
      task_id: null,
      runner_job_id: null,
      started_at: null,
      completed_at: null,
      guard_result: null,
    });
  }

  return {
    plan_id: planId,
    schema_version: LEDGER_SCHEMA_VERSION,
    items,
    started_at: null,
    completed_at: null,
  };
}

/**
 * Executes a compound plan wave-by-wave, respecting depends_on ordering and guards.
 *
 * The caller injects dispatchFn and materializeFn so this module has zero
 * coupling to dispatch or runner internals.
 *
 * @param {object} plan - A validated, normalized compound plan.
 * @param {Array<object>} decisions - Decisions array from buildCompoundDecisions().
 * @param {object} context - Execution context with injected functions.
 * @param {Function} context.dispatchFn - async (decision) => dispatchResult
 * @param {Function} context.materializeFn - async (decision, dispatchResult) => materialization_facts
 * @param {object} context.logger - { info, warn, error }
 * @param {object} [context.laneFeasibility] - Lane feasibility map.
 * @param {object} [context.runnerStatus] - Runner status object.
 * @returns {Promise<object>} The execution ledger (mutated in place and returned).
 */
export async function executeCompoundPlan(plan, decisions, context) {
  const logger = context && context.logger && typeof context.logger === "object"
    ? context.logger
    : { info() {}, warn() {}, error() {} };

  const laneFeasibility = (context && context.laneFeasibility && typeof context.laneFeasibility === "object")
    ? context.laneFeasibility
    : {};
  const runnerStatus = (context && context.runnerStatus && typeof context.runnerStatus === "object")
    ? context.runnerStatus
    : {};

  const ledger = createExecutionLedger(plan);
  ledger.started_at = Date.now();

  // Step b: Validate plan — if invalid, mark all items failed
  const validation = validateCompoundPlan(plan);
  if (!validation.valid) {
    logger.warn("compound_executor: plan validation failed, marking all items failed");
    for (const [, itemEntry] of ledger.items) {
      itemEntry.status = "failed";
      itemEntry.materialization_failed = true;
      itemEntry.completed_at = Date.now();
    }
    ledger.completed_at = Date.now();
    return ledger;
  }

  // Step c: Run lane validation — apply corrections to decisions
  const executionValidation = validateCompoundExecution(plan, laneFeasibility, runnerStatus);
  const laneCorrections = new Map();
  if (executionValidation && Array.isArray(executionValidation.items)) {
    for (const correction of executionValidation.items) {
      if (correction && correction.id && correction.lane_corrected) {
        laneCorrections.set(correction.id, correction.lane_corrected);
      }
    }
  }

  // Step d: Schedule to get waves
  const scheduled = scheduleCompoundPlan(plan);
  if (!scheduled || !Array.isArray(scheduled.waves) || scheduled.waves.length === 0) {
    logger.warn("compound_executor: scheduling produced no waves, marking all items failed");
    for (const [, itemEntry] of ledger.items) {
      itemEntry.status = "failed";
      itemEntry.materialization_failed = true;
      itemEntry.completed_at = Date.now();
    }
    ledger.completed_at = Date.now();
    return ledger;
  }

  // Step e: Build decisions Map keyed by item_id
  const decisionsMap = new Map();
  if (Array.isArray(decisions)) {
    for (const decision of decisions) {
      if (!decision || typeof decision !== "object") continue;
      const itemId = normalizeText(decision.item_id);
      if (itemId) {
        decisionsMap.set(itemId, decision);
      }
    }
  }

  // Step f: Execute wave-by-wave
  const workItemResults = new Map();

  for (const wave of scheduled.waves) {
    if (!Array.isArray(wave)) continue;

    for (const itemId of wave) {
      const itemEntry = ledger.items.get(itemId);

      if (!itemEntry) {
        logger.warn(`compound_executor: itemId "${itemId}" not found in ledger, skipping`);
        continue;
      }

      // Get decision from decisions Map
      let decision = decisionsMap.get(itemId);

      // Apply lane correction if present
      if (decision && laneCorrections.has(itemId)) {
        decision = { ...decision, lane: laneCorrections.get(itemId) };
      }

      if (!decision) {
        itemEntry.status = "skipped";
        itemEntry.completed_at = Date.now();
        logger.info(`compound_executor: no decision for itemId "${itemId}", skipping`);
        continue;
      }

      // Evaluate guard
      const planItem = scheduled.itemMap ? scheduled.itemMap.get(itemId) : null;
      const guard = planItem && planItem.guard ? planItem.guard : null;
      const guardResult = evaluateGuard(guard, workItemResults);

      if (!guardResult.passed) {
        itemEntry.status = "skipped";
        itemEntry.guard_result = guardResult;
        itemEntry.completed_at = Date.now();
        workItemResults.set(itemId, { skipped: true, guard_result: guardResult });
        logger.info(`compound_executor: guard failed for itemId "${itemId}": ${guardResult.reason}`);
        continue;
      }

      // Set running
      itemEntry.status = "running";
      itemEntry.started_at = Date.now();

      try {
        // Dispatch
        const dispatchFn = context && typeof context.dispatchFn === "function"
          ? context.dispatchFn
          : null;
        const dispatchResult = dispatchFn
          ? await dispatchFn(decision)
          : null;

        // Materialize
        const materializeFn = context && typeof context.materializeFn === "function"
          ? context.materializeFn
          : null;
        const materializationFacts = materializeFn
          ? await materializeFn(decision, dispatchResult)
          : null;

        // Success
        itemEntry.status = "completed";
        itemEntry.materialization_facts = materializationFacts || null;
        itemEntry.result = dispatchResult || null;
        itemEntry.completed_at = Date.now();

        if (dispatchResult && typeof dispatchResult === "object") {
          itemEntry.task_id = normalizeText(dispatchResult.task_id || dispatchResult.taskId || "");
          itemEntry.runner_job_id = normalizeText(dispatchResult.runner_job_id || dispatchResult.runnerJobId || "");
        }

        // Store materialization_facts for downstream guard evaluation
        workItemResults.set(itemId, materializationFacts || {});
        logger.info(`compound_executor: completed itemId "${itemId}"`);
      } catch (error) {
        itemEntry.status = "failed";
        itemEntry.materialization_failed = true;
        itemEntry.completed_at = Date.now();
        logger.error(`compound_executor: failed itemId "${itemId}": ${error && error.message ? error.message : error}`);
      }
    }
  }

  // Step g: Finalize ledger
  ledger.completed_at = Date.now();

  return ledger;
}

/**
 * Converts a Map-based execution ledger to a plain JSON-serializable object.
 *
 * @param {object} ledger - The execution ledger with Map-based items.
 * @returns {object} A plain object suitable for JSON serialization.
 */
export function ledgerToJSON(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return {
      plan_id: "",
      schema_version: LEDGER_SCHEMA_VERSION,
      items: {},
      started_at: null,
      completed_at: null,
    };
  }

  const itemsObj = {};
  const items = ledger.items;
  if (items instanceof Map) {
    for (const [id, entry] of items) {
      if (!entry || typeof entry !== "object") {
        itemsObj[id] = entry;
        continue;
      }
      itemsObj[id] = {
        status: entry.status || "pending",
        materialization_facts: entry.materialization_facts !== undefined ? entry.materialization_facts : null,
        materialization_failed: Boolean(entry.materialization_failed),
        result: entry.result !== undefined ? entry.result : null,
        task_id: entry.task_id !== undefined ? entry.task_id : null,
        runner_job_id: entry.runner_job_id !== undefined ? entry.runner_job_id : null,
        started_at: entry.started_at !== undefined ? entry.started_at : null,
        completed_at: entry.completed_at !== undefined ? entry.completed_at : null,
        guard_result: entry.guard_result !== undefined ? entry.guard_result : null,
      };
    }
  }

  return {
    plan_id: ledger.plan_id || "",
    schema_version: ledger.schema_version || LEDGER_SCHEMA_VERSION,
    items: itemsObj,
    started_at: ledger.started_at !== undefined ? ledger.started_at : null,
    completed_at: ledger.completed_at !== undefined ? ledger.completed_at : null,
  };
}
