import type { HandlerCommands } from "./host-rpc-handlers.mts";
import type { Method } from "./host-rpc-protocol.mts";

// Validated preferences; Docker remains responsible for native YAML settings.
export interface Preferences {
  schema_version: 1;
  network?: { allow: string[] };
  kit_aliases?: Record<string, string>;
  host_rpc?: { allow?: Method[]; handlers?: Partial<HandlerCommands> };
}

export interface ResolvedConfig {
  schemaVersion: 1;
  workspace: string;
  projectFile: string | null;
  globalFile: string | null;
  kitsChanged: boolean;
  environmentFiles: string[];
  nativeArguments: string[];
  networkAllow: string[];
  baseKitDirectory: string;
  hostRpcAllow: string;
  hostRpcHandlers: HandlerCommands;
  hostRpcHandlerCwd: string;
  sandboxName: string | null;
  baseKitVersion: string;
  baseKitFingerprint: string;
  fingerprint: string;
  stateFile: string;
}

export interface AppliedConfig extends ResolvedConfig {
  appliedAt: string;
}

export interface ConfigStatus {
  sandbox: string | null;
  projectDirectory: string;
  status: "not-created" | "unknown" | "exists";
  managedBy: string;
  environmentFiles: string[];
  hint: string;
}
