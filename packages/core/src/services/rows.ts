import type { AuditEvent, CredStatus, JobStatus, JobStep, OsType, Protocol, ProvisioningMethod, Role, StepState, VmStatus } from "@proxvm/shared";

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  given_name: string | null;
  password_hash: string;
  active: boolean;
  failed_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  is_initial_admin: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UserRoleRow extends UserRow {
  role_name: string | null;
}

export interface SessionRow {
  id: string;
  sid_hash: string;
  user_id: string;
  csrf_token: string;
  expires_at: Date;
  last_active_at: Date;
  idle_timeout_minutes: number;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

export interface AuditRow {
  id: string;
  event: AuditEvent;
  actor_user_id: string | null;
  actor_username: string | null;
  vm_id: string | null;
  job_id: string | null;
  ip: string | null;
  detail: unknown;
  created_at: Date;
}

export interface VmRow {
  id: string;
  vmid: number;
  node: string;
  name: string;
  status: VmStatus;
  os_type: OsType | null;
  os_name: string | null;
  ip_address: string | null;
  created_by_user_id: string | null;
  template_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  privacy_flag: boolean;
}

export interface CredentialRow {
  id: string;
  vm_id: string;
  username: string;
  password_ciphertext: string;
  key_id: string;
  status: CredStatus;
  created_at: Date;
  last_verified_at: Date | null;
  last_rotated_at: Date | null;
}

export interface TemplateRow {
  id: string;
  name: string;
  node: string;
  proxmox_vmid: number;
  os_type: OsType;
  provisioning_method: ProvisioningMethod;
  cloud_init_support: boolean;
  guest_agent_required: boolean;
  default_cpu: number;
  default_ram_mb: number;
  default_disk_gb: number;
  supported_protocols: Protocol[];
  created_at: Date;
  updated_at: Date;
}

export interface GuacConnectionRow {
  id: string;
  vm_id: string;
  protocol: Protocol;
  hostname: string;
  port: number;
  username: string;
  password_ciphertext: string;
  key_id: string;
  guac_connection_name: string;
  guac_identifier: string | null;
  status: "PENDING" | "ACTIVE" | "FAILED";
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface GuacUserRow {
  id: string;
  user_id: string;
  guac_username: string;
  password_ciphertext: string;
  key_id: string;
  status: "PENDING" | "ACTIVE" | "FAILED";
  sync_state: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface JobRow {
  id: string;
  vm_id: string | null;
  status: JobStatus;
  error: string | null;
  request: Record<string, unknown>;
  created_by_user_id: string | null;
  bull_job_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface StepRow {
  id: string;
  job_id: string;
  step: JobStep;
  state: StepState;
  detail: unknown;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface CountRow {
  count: string;
}

export interface RoleRow {
  id: string;
  name: Role;
}

export { RoleRow as unusedRoleRow };