export const THREAD_BINDING_SCHEMA_VERSION = "octoclaw.thread_binding.v1" as const;

export interface ThreadBinding {
  schemaVersion: typeof THREAD_BINDING_SCHEMA_VERSION;
  threadBindingKey: string;
  requesterSessionKey: string;
  requesterOrigin?: unknown;
  surfaceAnchorId?: string;
  channel?: string;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
}
