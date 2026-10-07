import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test events and contexts deliberately contain only the fields a given extension
// consumes. Keep the partial-API cast at this boundary, not in production code.
type TestHandler = (event?: unknown, context?: unknown) => unknown;
interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: undefined,
    context: unknown,
  ) => Promise<unknown>;
}

export function extensionHarness(
  extension: (pi: ExtensionAPI) => void,
  sessionName = "Named session",
) {
  const handlers: Record<string, TestHandler> = {};
  const tools: CapturedTool[] = [];
  const api = {
    on: (event: string, handler: TestHandler) => {
      handlers[event] = handler;
    },
    registerTool: (tool: CapturedTool) => {
      tools.push(tool);
    },
    getSessionName: () => sessionName,
  };
  extension(api as unknown as ExtensionAPI);
  return { handlers, tools };
}
