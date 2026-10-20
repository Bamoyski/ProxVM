/** Shared VM row shape returned by GET /vms (list projection). */
export interface VmRow {
  id: string | null;
  vmid: number;
  node: string;
  name: string;
  tracked: boolean;
  status: string;
  osType: string | null;
  osName: string | null;
  os: string | null;
  ip: string | null;
  cpu: { used: number | null; max: number } | null;
  mem: { used: number | null; max: number } | null;
  disk: { used: number | null; max: number } | null;
  uptime: number | null;
  guacamole: { created: boolean; status: string | null; protocol: string | null; port: number | null } | null;
  credentialStatus: string | null;
  private?: boolean;
  isolated?: boolean;
}

/** Lifecycle labels shown to humans for known states. */
export function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "paused":
      return "Paused";
    case "unknown":
      return "Unknown";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}
