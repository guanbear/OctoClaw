import crypto from "node:crypto";
import { INTENT_CLASSES } from "./intent.js";

export const COMPOUND_PLAN_SCHEMA_VERSION = "octoclaw.compound_plan/v1";

const VALID_DECISION_MODES = new Set(["simple_route", "compound_plan"]);
const VALID_LANES = new Set(["direct", "runner", "spawn_single"]);
const VALID_GUARD_TYPES = new Set(["ref_eq", "ref_gt"]);
const VALID_STATUSES = new Set(["pending", "ready", "running", "completed", "skipped", "failed"]);
const VALID_FALLBACKS = new Set(["notify_user", "skip_silent"]);
const VALID_INTENT_CLASS_VALUES = new Set(Object.values(INTENT_CLASSES));
const MAX_DEPTH_CAP = 3;

const LANE_SORT_ORDER = { direct: 0, runner: 1, spawn_single: 2 };

function normalizeText(value) {
  return String(value || "").trim();
}

function generatePlanId() {
  const hex = crypto.randomBytes(8).toString("hex");
  return `cp_${hex}`;
}

export function buildCompoundPlanSchema() {
  return {
    schema_version: COMPOUND_PLAN_SCHEMA_VERSION,
    decision_modes: [...VALID_DECISION_MODES],
    valid_lanes: [...VALID_LANES],
    valid_intent_classes: [...VALID_INTENT_CLASS_VALUES],
    valid_statuses: [...VALID_STATUSES],
    valid_guard_types: [...VALID_GUARD_TYPES],
    valid_fallbacks: [...VALID_FALLBACKS],
    max_depth_cap: MAX_DEPTH_CAP,
  };
}

export function validateCompoundPlan(plan) {
  const errors = [];

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { valid: false, errors: ["plan must be a non-null object"] };
  }

  if (normalizeText(plan.schema_version) !== COMPOUND_PLAN_SCHEMA_VERSION) {
    errors.push(`schema_version must equal "${COMPOUND_PLAN_SCHEMA_VERSION}"`);
  }

  const decisionMode = normalizeText(plan.decision_mode);
  if (!VALID_DECISION_MODES.has(decisionMode)) {
    errors.push("decision_mode must be 'simple_route' or 'compound_plan'");
  }

  if (decisionMode === "simple_route") {
    const items = plan.work_items;
    if (items !== undefined && items !== null) {
      if (!Array.isArray(items)) {
        errors.push("work_items must be an array when present");
      } else if (items.length > 0) {
        errors.push("work_items must be empty for simple_route decision_mode");
      }
    }
    return { valid: errors.length === 0, errors };
  }

  if (decisionMode === "compound_plan") {
    if (!Array.isArray(plan.work_items) || plan.work_items.length === 0) {
      errors.push("work_items must be a non-empty array for compound_plan decision_mode");
      return { valid: false, errors };
    }
  }

  const items = Array.isArray(plan.work_items) ? plan.work_items : [];
  const idSet = new Set();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`work_items[${index}] must be a non-null object`);
      continue;
    }

    const id = normalizeText(item.id);
    if (!id) {
      errors.push(`work_items[${index}].id must be a non-empty string`);
    } else if (idSet.has(id)) {
      errors.push(`work_items[${index}].id is duplicate: "${id}"`);
    } else {
      idSet.add(id);
    }

    const lane = normalizeText(item.lane);
    if (!VALID_LANES.has(lane)) {
      errors.push(`work_items[${index}].lane must be one of: direct, runner, spawn_single`);
    }

    const intentClass = normalizeText(item.intent_class);
    if (!VALID_INTENT_CLASS_VALUES.has(intentClass)) {
      errors.push(`work_items[${index}].intent_class must be a valid intent class`);
    }

    if (item.depends_on !== undefined && item.depends_on !== null) {
      if (!Array.isArray(item.depends_on)) {
        errors.push(`work_items[${index}].depends_on must be an array`);
      }
    }

    if (item.guard !== null && item.guard !== undefined) {
      const guard = item.guard;
      if (!guard || typeof guard !== "object" || Array.isArray(guard)) {
        errors.push(`work_items[${index}].guard must be an object when present`);
      } else {
        const guardType = normalizeText(guard.type);
        if (!VALID_GUARD_TYPES.has(guardType)) {
          errors.push(`work_items[${index}].guard.type must be 'ref_eq' or 'ref_gt'`);
        }
        if (!normalizeText(guard.ref_path)) {
          errors.push(`work_items[${index}].guard.ref_path must be a non-empty string`);
        }
        if (guardType === "ref_gt") {
          if (!Number.isFinite(guard.expected)) {
            errors.push(`work_items[${index}].guard.expected must be a finite number for ref_gt`);
          }
        }
      }
    }
  }

  const maxDepth = Number(plan.max_depth);
  if (!Number.isFinite(maxDepth) || maxDepth < 1) {
    errors.push("max_depth must be a positive finite number");
  } else if (maxDepth > MAX_DEPTH_CAP) {
    errors.push(`max_depth must be <= ${MAX_DEPTH_CAP}`);
  }

  const adjacency = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const id = normalizeText(item.id);
    if (!id) continue;
    const deps = Array.isArray(item.depends_on) ? item.depends_on : [];
    const resolvedDeps = [];
    for (const dep of deps) {
      const depId = normalizeText(dep);
      if (!idSet.has(depId)) {
        errors.push(`work_item "${id}" depends_on unknown id "${depId}"`);
      } else {
        resolvedDeps.push(depId);
      }
    }
    adjacency.set(id, resolvedDeps);
  }

  // DFS three-color cycle detection: WHITE=unvisited, GRAY=in-progress, BLACK=done
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of idSet) {
    color.set(id, WHITE);
  }

  function dfsVisit(nodeId) {
    color.set(nodeId, GRAY);
    const deps = adjacency.get(nodeId) || [];
    for (const dep of deps) {
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        return true;
      }
      if (depColor === WHITE) {
        if (dfsVisit(dep)) return true;
      }
    }
    color.set(nodeId, BLACK);
    return false;
  }

  let hasCycle = false;
  for (const id of idSet) {
    if (color.get(id) === WHITE) {
      if (dfsVisit(id)) {
        hasCycle = true;
        break;
      }
    }
  }
  if (hasCycle) {
    errors.push("work_items contain circular dependencies");
  }

  return { valid: errors.length === 0, errors };
}

export function scheduleCompoundPlan(plan) {
  const empty = { waves: [], itemMap: new Map(), depthMap: new Map() };

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return empty;

  const validation = validateCompoundPlan(plan);
  if (!validation.valid) return empty;

  const items = Array.isArray(plan.work_items) ? plan.work_items : [];
  if (items.length === 0) return empty;

  const itemMap = new Map();
  const depthMap = new Map();

  for (const item of items) {
    const id = normalizeText(item.id);
    if (id) itemMap.set(id, item);
  }

  const inDegree = new Map();
  const adjacency = new Map();

  for (const [id] of itemMap) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const [id, item] of itemMap) {
    const deps = Array.isArray(item.depends_on) ? item.depends_on.map((d) => normalizeText(d)) : [];
    inDegree.set(id, deps.length);
    for (const dep of deps) {
      if (adjacency.has(dep)) {
        adjacency.get(dep).push(id);
      }
    }
  }

  const queue = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      depthMap.set(id, 0);
      queue.push(id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const currentDepth = depthMap.get(current);
    for (const dependent of (adjacency.get(current) || [])) {
      const newDegree = (inDegree.get(dependent) || 0) - 1;
      inDegree.set(dependent, newDegree);
      const proposedDepth = currentDepth + 1;
      const existingDepth = depthMap.get(dependent);
      if (existingDepth === undefined || proposedDepth > existingDepth) {
        depthMap.set(dependent, proposedDepth);
      }
      if (newDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  const waveMap = new Map();
  for (const [id, depth] of depthMap) {
    if (!waveMap.has(depth)) waveMap.set(depth, []);
    waveMap.get(depth).push(id);
  }

  const maxDepth = Math.max(0, ...depthMap.values());
  const waves = [];
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const waveItems = waveMap.get(depth) || [];
    waveItems.sort((a, b) => {
      const laneA = normalizeText(itemMap.get(a)?.lane);
      const laneB = normalizeText(itemMap.get(b)?.lane);
      const orderA = LANE_SORT_ORDER[laneA] !== undefined ? LANE_SORT_ORDER[laneA] : 99;
      const orderB = LANE_SORT_ORDER[laneB] !== undefined ? LANE_SORT_ORDER[laneB] : 99;
      return orderA - orderB;
    });
    waves.push(waveItems);
  }

  return { waves, itemMap, depthMap };
}

export function evaluateGuard(guard, workItemResults) {
  if (!guard || typeof guard !== "object") {
    return { passed: true, reason: "no_guard" };
  }

  const refItem = normalizeText(guard.ref_item);
  const refPath = normalizeText(guard.ref_path);
  const guardType = normalizeText(guard.type);

  const results = workItemResults instanceof Map ? workItemResults : new Map(Object.entries(workItemResults || {}));

  if (!refItem || !results.has(refItem)) {
    return { passed: false, reason: "ref_item_not_completed" };
  }

  const itemResult = results.get(refItem);

  let resolved = itemResult;
  if (refPath) {
    const segments = refPath.split(".");
    for (const segment of segments) {
      if (resolved === null || resolved === undefined || typeof resolved !== "object") {
        return { passed: false, reason: "ref_path_not_found" };
      }
      resolved = resolved[segment];
    }
  }

  if (resolved === undefined) {
    return { passed: false, reason: "ref_path_not_found" };
  }

  if (guardType === "ref_eq") {
    return resolved === guard.expected
      ? { passed: true, reason: "ref_eq_match" }
      : { passed: false, reason: "ref_eq_mismatch" };
  }

  if (guardType === "ref_gt") {
    const resolvedNum = Number(resolved);
    const expectedNum = Number(guard.expected);
    if (!Number.isFinite(resolvedNum) || !Number.isFinite(expectedNum)) {
      return { passed: false, reason: "ref_gt_non_finite" };
    }
    return resolvedNum > expectedNum
      ? { passed: true, reason: "ref_gt_satisfied" }
      : { passed: false, reason: "ref_gt_not_satisfied" };
  }

  return { passed: false, reason: "unknown_guard_type" };
}

export function normalizeCompoundPlan(raw) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  const schemaVersion = COMPOUND_PLAN_SCHEMA_VERSION;
  const planId = normalizeText(input.plan_id) || generatePlanId();
  const correlationId = normalizeText(input.correlation_id || "");
  const decisionMode = VALID_DECISION_MODES.has(normalizeText(input.decision_mode))
    ? normalizeText(input.decision_mode)
    : "simple_route";

  const rawMaxDepth = Number(input.max_depth);
  const maxDepth = Number.isFinite(rawMaxDepth) && rawMaxDepth > 0
    ? Math.min(MAX_DEPTH_CAP, Math.floor(rawMaxDepth))
    : MAX_DEPTH_CAP;

  const rawItems = Array.isArray(input.work_items) ? input.work_items : [];
  const workItems = rawItems.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        id: generatePlanId(),
        intent_class: INTENT_CLASSES.UNDETERMINED,
        lane: "direct",
        goal: "",
        depends_on: [],
        guard: null,
        user_visible: false,
        status: "pending",
        result_slot: null,
        fallback: "notify_user",
      };
    }

    const id = normalizeText(item.id) || generatePlanId();
    const intentClass = normalizeText(item.intent_class);
    const lane = normalizeText(item.lane);
    const goal = normalizeText(item.goal || "");
    const dependsOn = Array.isArray(item.depends_on)
      ? item.depends_on.map((d) => normalizeText(d)).filter(Boolean)
      : [];

    let guard = null;
    if (item.guard && typeof item.guard === "object" && !Array.isArray(item.guard)) {
      const guardType = normalizeText(item.guard.type);
      if (VALID_GUARD_TYPES.has(guardType)) {
        guard = {
          type: guardType,
          ref_item: normalizeText(item.guard.ref_item),
          ref_path: normalizeText(item.guard.ref_path),
          expected: item.guard.expected,
        };
      }
    }

    const fallback = VALID_FALLBACKS.has(normalizeText(item.fallback))
      ? normalizeText(item.fallback)
      : "notify_user";

    return {
      id,
      intent_class: VALID_INTENT_CLASS_VALUES.has(intentClass) ? intentClass : INTENT_CLASSES.UNDETERMINED,
      lane: VALID_LANES.has(lane) ? lane : "direct",
      goal,
      depends_on: dependsOn,
      guard,
      user_visible: Boolean(item.user_visible),
      status: "pending",
      result_slot: null,
      fallback,
    };
  });

  const normalizedPlan = {
    schema_version: schemaVersion,
    plan_id: planId,
    correlation_id: correlationId,
    decision_mode: decisionMode,
    max_depth: maxDepth,
    work_items: workItems,
  };

  const validation = validateCompoundPlan(normalizedPlan);

  return {
    ...normalizedPlan,
    valid: validation.valid,
    errors: validation.errors,
  };
}

export function validateCompoundExecution(plan, laneFeasibility = {}, runnerStatus = {}) {
  const overallErrors = [];

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return {
      valid: false,
      items: [],
      overall_errors: ["plan must be a non-null object"],
    };
  }

  const items = Array.isArray(plan.work_items) ? plan.work_items : [];
  const itemResults = [];

  for (const item of items) {
    const id = normalizeText(item?.id) || "";
    const lane = normalizeText(item?.lane);
    const intentClass = normalizeText(item?.intent_class);

    const errors = [];
    let laneCorrected = null;
    let correctionReason = "";

    if (lane in laneFeasibility && laneFeasibility[lane]?.feasible === false) {
      laneCorrected = "direct";
      correctionReason = `lane_infeasible:${lane}`;
    }

    if (lane === "runner" && (runnerStatus.available === false || runnerStatus.materialization_capable === false)) {
      laneCorrected = "direct";
      correctionReason = "degraded_direct_lookup:runner_unavailable";
    }

    if (lane === "runner"
      && runnerStatus.available !== false
      && runnerStatus.materialization_capable !== false
      && Array.isArray(runnerStatus.supported_intents)
      && !runnerStatus.supported_intents.includes(intentClass)) {
      laneCorrected = "direct";
      correctionReason = `degraded_direct_lookup:runner_intent_unsupported:${intentClass}`;
    }

    if (intentClass === "execution_followup" && lane !== "direct") {
      laneCorrected = "direct";
      correctionReason = "execution_followup_must_be_direct";
    }

    if (lane === "spawn_single" && intentClass !== "delegated_work") {
      errors.push("spawn_single requires delegated_work intent_class");
    }

    const laneValid = errors.length === 0 && laneCorrected === null;

    itemResults.push({
      id,
      lane_valid: laneValid,
      lane_corrected: laneCorrected,
      correction_reason: correctionReason,
      errors,
    });
  }

  const valid = itemResults.every((r) => r.lane_valid) && overallErrors.length === 0;

  return {
    valid,
    items: itemResults,
    overall_errors: overallErrors,
  };
}
