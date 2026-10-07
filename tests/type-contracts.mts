import type {
  callHost,
  enqueue,
  HostRequest,
  HostHandlers,
} from "../scripts/host-rpc-protocol.mts";

// Compile-only public API checks: method/parameter correlation must not regress
// to independent unions or a loose string + object signature.
type Assert<T extends true> = T;
type Accepts<Args, FnArgs> = Args extends FnArgs ? true : false;
type Rejects<Args, FnArgs> = Args extends FnArgs ? false : true;
type EnqueueArgs = Parameters<typeof enqueue>;
type CallArgs = Parameters<typeof callHost>;

export type RpcContracts = [
  Assert<Rejects<HostRequest<"notification.send">, Parameters<HostHandlers["network.request"]>[0]>>,
  Assert<Rejects<HostRequest<"file.access">, Parameters<HostHandlers["notification.send"]>[0]>>,
  Assert<
    Accepts<[string, string, "notification.send", { title: string; body: string }], EnqueueArgs>
  >,
  Assert<
    Accepts<
      [string, string, "network.request", { host: string; reason: string }, AbortSignal],
      CallArgs
    >
  >,
  Assert<
    Accepts<
      [string, string, "file.access", { path: string; toolCallId: string; phase: "success" }],
      EnqueueArgs
    >
  >,
  Assert<
    Rejects<[string, string, "network.request", { title: string; body: string }], EnqueueArgs>
  >,
  Assert<
    Rejects<[string, string, "notification.send", { host: string; reason: string }], CallArgs>
  >,
  Assert<Rejects<[string, string, "shell.exec", { command: string }], EnqueueArgs>>,
  Assert<
    Rejects<
      [string, string, "file.access", { path: string; toolCallId: string; phase: "approved" }],
      EnqueueArgs
    >
  >,
  Assert<
    Rejects<
      {
        jsonrpc: "2.0";
        sbxVersion: 1;
        id: string;
        session: string;
        method: "network.request";
        params: { title: string; body: string };
      },
      HostRequest
    >
  >,
];
