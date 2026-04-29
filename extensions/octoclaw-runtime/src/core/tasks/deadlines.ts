export interface RuntimeDeadlines {
  queueDeadline: string;
  startDeadline: string;
  progressDeadline: string;
  runtimeDeadline: string;
  deliveryDeadline: string;
}

export type RuntimeDeadlineField = keyof RuntimeDeadlines;
export type RuntimeDeadlinePhase =
  | "pre_start"
  | "running"
  | "checkpoint"
  | "delivery"
  | "terminal";

export interface DeadlineBudgetInput {
  queuedAt?: string;
  queueMs: number;
  startMs: number;
  progressMs: number;
  runtimeMs: number;
  deliveryMs: number;
}

export function buildRuntimeDeadlines(input: DeadlineBudgetInput): RuntimeDeadlines {
  const queuedAt = new Date(input.queuedAt ?? new Date().toISOString());
  const queueDeadline = new Date(queuedAt.getTime() + input.queueMs);
  const startDeadline = new Date(queuedAt.getTime() + input.startMs);
  const progressDeadline = new Date(queuedAt.getTime() + input.progressMs);
  const runtimeDeadline = new Date(queuedAt.getTime() + input.runtimeMs);
  const deliveryDeadline = new Date(queuedAt.getTime() + input.deliveryMs);

  return {
    queueDeadline: queueDeadline.toISOString(),
    startDeadline: startDeadline.toISOString(),
    progressDeadline: progressDeadline.toISOString(),
    runtimeDeadline: runtimeDeadline.toISOString(),
    deliveryDeadline: deliveryDeadline.toISOString(),
  };
}

export function hasDeadlineExpired(deadline: string, now = new Date()): boolean {
  return new Date(deadline).getTime() <= now.getTime();
}

export function enforceableDeadlinesForPhase(phase: RuntimeDeadlinePhase): RuntimeDeadlineField[] {
  switch (phase) {
    case "pre_start":
      return ["queueDeadline", "startDeadline"];
    case "running":
    case "checkpoint":
      return ["progressDeadline", "runtimeDeadline"];
    case "delivery":
      return ["deliveryDeadline"];
    case "terminal":
      return [];
  }
}

export function nextDeadlineToEnforce(
  deadlines: RuntimeDeadlines,
  now = new Date(),
  enforceableFields: RuntimeDeadlineField[] = [
    "queueDeadline",
    "startDeadline",
    "progressDeadline",
    "runtimeDeadline",
    "deliveryDeadline",
  ],
): RuntimeDeadlineField | null {
  return enforceableFields.find((name) => hasDeadlineExpired(deadlines[name], now)) ?? null;
}

export function nextUpcomingDeadline(
  deadlines: RuntimeDeadlines,
  now = new Date(),
  enforceableFields: RuntimeDeadlineField[] = [
    "queueDeadline",
    "startDeadline",
    "progressDeadline",
    "runtimeDeadline",
    "deliveryDeadline",
  ],
): RuntimeDeadlineField | null {
  return enforceableFields.find((name) => !hasDeadlineExpired(deadlines[name], now)) ?? null;
}
