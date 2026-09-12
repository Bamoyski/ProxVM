import type {
  AuditEvent,
  CredStatus,
  JobStatus,
  JobStep,
  NetworkMode,
  OsType,
  Protocol,
  ProvisioningMethod,
  Role,
  VmStatus,
} from "./enums.js";
import type { LocalConfig } from "./schemas.js";

export interface User {
  id: string;
  username: string;
  email: string | null;
  givenName: string | null;
  passwordHash: string;
  active: boolean;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  sidHash: string;
  userId: string;
  csrfToken: string;
  expiresAt: Date;
  lastActiveAt: Date;
  idleTimeoutMinutes: number;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface UserWithRoles extends User {
  roles: Role[];
  isInitialAdmin: boolean;
}

export interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  givenName: string | null;
  roles: Role[];
  active: boolean;
  isInitialAdmin: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
}

export interface AuditRecord {
  id: string;
  event: AuditEvent;
  actorUserId: string | null;
  actorUsername: string | null;
  vmId: string | null;
  jobId: string | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

export interface SettingRecord {
  key: string;
  value: string;
  encrypted: boolean;
  category: string;
  updatedAt: Date;
}

export interface VmRecord {
  id: string;
  vmid: number;
  node: string;
  name: string;
  status: VmStatus;
  osType: OsType | null;
  osName: string | null;
  ipAddress: string | null;
  templateId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface VmCredentialRecord {
  id: string;
  vmId: string;
  username: string;
  passwordCiphertext: string;
  keyId: string;
  status: CredStatus;
  createdAt: Date;
  lastVerifiedAt: Date | null;
  lastRotatedAt: Date | null;
}

export interface TemplateRecord {
  id: string;
  name: string;
  node: string;
  proxmoxVmid: number;
  osType: OsType;
  provisioningMethod: ProvisioningMethod;
  cloudInitSupport: boolean;
  guestAgentRequired: boolean;
  defaultCpu: number;
  defaultRamMb: number;
  defaultDiskGb: number;
  supportedProtocols: Protocol[];
  createdAt: Date;
  updatedAt: Date;
}

export interface GuacamoleConnectionRecord {
  id: string;
  vmId: string;
  protocol: Protocol;
  hostname: string;
  port: number;
  username: string;
  passwordCiphertext: string;
  keyId: string;
  guacConnectionName: string;
  guacIdentifier: string | null;
  status: "PENDING" | "ACTIVE" | "FAILED";
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GuacamoleUserRecord {
  id: string;
  userId: string;
  guacUsername: string;
  passwordCiphertext: string;
  keyId: string;
  status: "PENDING" | "ACTIVE" | "FAILED";
  syncState: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProvisioningJobRecord {
  id: string;
  vmId: string | null;
  status: JobStatus;
  error: string | null;
  request: Record<string, unknown>;
  createdByUserId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProvisioningStepRecord {
  id: string;
  jobId: string;
  step: JobStep;
  state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  detail: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface VmAccessRecord {
  vmId: string;
  userId: string;
  createdAt: Date;
}

export interface ProxmoxNodeStatus {
  node: string;
  status: "online" | "offline" | "unknown";
  cpu: number | null;
  maxcpu: number;
  memUsed: number | null;
  memTotal: number | null;
  uptime: number | null;
  pveVersion: string | null;
}

export interface ProxmoxQemuResource {
  vmid: number;
  node: string;
  name: string;
  status: "running" | "stopped" | "paused";
  template: 0 | 1;
  maxcpu: number;
  cpu: number | null;
  mem: number | null;
  maxmem: number;
  maxdisk: number;
  disk: number | null;
  uptime: number | null;
  netin: number | null;
  netout: number | null;
  vcpus?: number;
  diskread?: number | null;
  diskwrite?: number | null;
}

export interface ProxmoxVmConfig {
  name: string;
  memory: number;
  cores: number;
  sockets: number;
  ostype: string;
  boot: string;
  scsihw: string;
  agent: string;
  tags: string;
  net: Array<Record<string, unknown>> | null;
  scsi0: string | undefined;
  ide2: string | undefined;
  ciupgrade?: string;
  ciuser?: string;
  searchdomain?: string;
  nameserver?: string;
  sshkeys?: string;
  ipconfig0?: string;
  description?: string;
  proxmoxId?: number;
  [key: string]: unknown;
}

export interface ProxmoxAgentInfo {
  reachable: boolean;
  osType: string | null;
  hostname: string | null;
  version: string | null;
  ipv4s: string[];
  interfaces: Array<{ name: string; addresses: string[] }>;
}

export interface StorageEntry {
  storage: string;
  type: string;
  content: string;
  node: string;
  shared: number;
  avail: number;
  used: number;
  total: number;
}

export interface NetworkEntry {
  iface: string;
  type: string;
  method: string | null;
  autostart: number;
  active: number;
  address: string | null;
  bridgePorts: string | null;
  comments: string | null;
}

export interface ProxmoxPveResult {
  version: string;
  release: string;
  repoid: string;
}

export interface PreviewVm extends VmRecord {
  proxmox: ProxmoxQemuResource | null;
  templateUsed: string | null;
  hasCredentials: boolean;
  credentialStatus: CredStatus | null;
  guacamole: {
    created: boolean;
    active: boolean;
    protocol: Protocol | null;
    port: number | null;
  } | null;
  access: "full" | "limited" | null;
}

export interface JobProgressData {
  jobId: string;
  vmId: string | null;
  status: JobStatus;
  step: JobStep | null;
  error: string | null;
  progress: number;
  message: string;
  ts: string;
}

export interface GuacamoleConnectionPayload {
  vmId: string;
  protocol: Protocol;
  hostname: string;
  port: number;
  username: string;
  password: string;
}

export interface GuacamoleTokenResponse {
  authToken: string;
  username: string;
  dataSource: string;
  availableDataSources: string[];
}

export interface LoginResponse {
  user: PublicUser;
  csrfToken: string;
}

export interface SetupStatusResponse {
  configured: boolean;
  initialized: boolean;
  completedSteps: number[];
}

export interface DatabaseSnapshot extends LocalConfig {
  redisDefaulted: boolean;
}