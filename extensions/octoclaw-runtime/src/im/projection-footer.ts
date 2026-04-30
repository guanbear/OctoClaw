import { getAdapterForChannel, getAdapterForSession } from "./index.js";
import type { IMProjectionFooter } from "./adapter.js";

export interface RenderIMProjectionFooterParams {
  content: string;
  projection: IMProjectionFooter;
  sessionKey?: string;
  channel?: string;
}

export function renderIMProjectionFooter(params: RenderIMProjectionFooterParams): string {
  const content = String(params.content ?? "");
  const adapter = (params.sessionKey ? getAdapterForSession(params.sessionKey) : null)
    ?? (params.channel ? getAdapterForChannel(params.channel) : null);
  if (!adapter?.renderProjectionFooter) return content;
  return adapter.renderProjectionFooter(content, params.projection);
}
