import type { WorkspaceMode } from "@octoclaw/contracts/schemas";
import { decideRoute as inferRoute, type RouteDecision, type RouteInput } from "@octoclaw/policy/route";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

type JsonRpcId = number;

interface InferRouteLegacyMetadata {
  requested_route?: string;
  route?: string;
  requestedRoute?: string;
  hardBoundaryControl?: boolean;
  requiresObservation?: boolean;
  requiresDelegation?: boolean;
  capabilitySatisfied?: boolean;
  workspaceMode?: string;
  workspace_mode?: string;
  conversation_control?: {
    required?: boolean;
    intent_class?: string;
  };
}

interface InferRouteArgs extends Partial<RouteInput> {
  task?: string;
  command?: string;
  metadata?: InferRouteLegacyMetadata;
}

interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  args?: InferRouteArgs;
}

interface JsonRpcSuccessResponse {
  id: JsonRpcId;
  result: RouteDecision;
}

interface JsonRpcErrorResponse {
  id: JsonRpcId;
  error: string;
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

type BridgeMethod = (args: InferRouteArgs) => RouteDecision | Promise<RouteDecision>;

function isWorkspaceMode(value: string): value is WorkspaceMode {
  return value === "isolated_worktree" || value === "shared_workspace" || value === "read_only";
}

function normalizeWorkspaceMode(value: unknown, fallback: WorkspaceMode = "shared_workspace"): WorkspaceMode {
  const candidate = String(value ?? "").trim();
  return isWorkspaceMode(candidate) ? candidate : fallback;
}

function buildInferRouteInput(args: InferRouteArgs = {}): RouteInput {
  const metadata = args.metadata;
  const requestedRoute = String(
    args.requestedRoute
      ?? args.metadata?.requested_route
      ?? args.metadata?.route
      ?? args.metadata?.requestedRoute
      ?? "",
  ).trim();
  const capabilitySatisfied = args.capabilitySatisfied ?? metadata?.capabilitySatisfied;

  return {
    requestedRoute: requestedRoute || undefined,
    hardBoundaryControl: Boolean(args.hardBoundaryControl ?? metadata?.conversation_control?.required ?? metadata?.hardBoundaryControl),
    requiresObservation: Boolean(
      args.requiresObservation
        ?? metadata?.requiresObservation
        ?? (metadata?.conversation_control?.intent_class === "execution_followup"),
    ),
    requiresDelegation: Boolean(args.requiresDelegation ?? metadata?.requiresDelegation),
    capabilitySatisfied: typeof capabilitySatisfied === "boolean" ? capabilitySatisfied : true,
    workspaceMode: normalizeWorkspaceMode(args.workspaceMode ?? metadata?.workspaceMode ?? metadata?.workspace_mode),
  };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<JsonRpcRequest>;
  return typeof candidate.id === "number" && typeof candidate.method === "string";
}

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const methods: Record<string, BridgeMethod> = {
  inferRoute: (args) => inferRoute(buildInferRouteInput(args)),
};

export function startBridge(): readline.Interface {
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", async (line: string) => {
    let payload: unknown;
    try {
      payload = JSON.parse(line) as unknown;
    } catch {
      return;
    }

    if (!isJsonRpcRequest(payload)) {
      return;
    }

    const request = payload;

    try {
      const handler = methods[request.method];
      if (!handler) {
        throw new Error(`Unknown method: ${request.method}`);
      }

      const result = await handler(request.args ?? {});
      writeResponse({ id: request.id, result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      writeResponse({ id: request.id, error: message });
    }
  });

  return rl;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startBridge();
}
