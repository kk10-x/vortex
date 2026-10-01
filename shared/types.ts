export type Strategy = "round-robin" | "hash";

export interface WorkerInfo {
  id: number;
  healthy: boolean;
  served: number;
}

export interface Config {
  strategy: Strategy;
  rps: number;
  rateLimit: { rate: number; burst: number };
}

export interface Stats {
  sent: number;
  limited: number;
  rerouted: number;
  failed: number;
}

export type VortexEvent =
  | { type: "state"; workers: WorkerInfo[]; config: Config; stats: Stats }
  | { type: "routed"; id: number; key: string; worker: number; retried: boolean }
  | { type: "done"; id: number; worker: number; ms: number }
  | { type: "limited"; id: number; key: string }
  | { type: "retry"; id: number; from: number }
  | { type: "failed"; id: number; key: string }
  | { type: "worker"; id: number; state: "up" | "down" }
  | { type: "config"; config: Config };
