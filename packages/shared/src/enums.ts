export const ROLES = ["ADMIN", "OPERATOR", "USER"] as const;
export type Role = (typeof ROLES)[number];

export const OS_TYPES = ["linux", "windows"] as const;
export type OsType = (typeof OS_TYPES)[number];

export const PROTOCOLS = ["ssh", "rdp", "vnc"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const PROVISIONING_METHODS = ["cloud-init", "cloudbase-init", "unattend", "none"] as const;
export type ProvisioningMethod = (typeof PROVISIONING_METHODS)[number];

export const JOB_STATUS = [
  "PENDING",
  "CREATING",
  "PROVISIONING",
  "WAITING_FOR_GUEST",
  "CONFIGURING",
  "VERIFYING",
  "GUACAMOLE_CREATING",
  "READY",
  "FAILED",
  "CANCELLED",
] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const JOB_STEPS = [
  "VALIDATE_PROXMOX_RESOURCES",
  "CLONE_TEMPLATE",
  "CONFIGURE_VM",
  "CONFIGURE_GUEST_PROVISIONING",
  "START_VM",
  "WAIT_FOR_GUEST",
  "DISCOVER_IP",
  "VERIFY_GUEST",
  "VERIFY_CREDENTIALS",
  "CREATE_GUACAMOLE_CONNECTION",
  "VERIFY_GUACAMOLE",
] as const;
export type JobStep = (typeof JOB_STEPS)[number];

export const STEP_STATE = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"] as const;
export type StepState = (typeof STEP_STATE)[number];

export const VM_STATUS = ["pending", "running", "stopped", "failed", "not_found"] as const;
export type VmStatus = (typeof VM_STATUS)[number];

export const CRED_STATUS = [
  "NONE",
  "ENCRYPTED",
  "PROVISIONED",
  "VERIFIED",
  "ROTATING",
  "FAILED",
] as const;
export type CredStatus = (typeof CRED_STATUS)[number];

export const AUDIT_EVENTS = [
  "LOGIN",
  "LOGIN_FAILED",
  "LOGOUT",
  "VM_CREATED",
  "VM_DELETED",
  "VM_STARTED",
  "VM_STOPPED",
  "VM_RESTARTED",
  "VM_EDITED",
  "VM_CLONED",
  "VM_MIGRATED",
  "PRIVACY_ENABLED",
  "PRIVACY_DISABLED",
  "PASSWORD_CREATED",
  "PASSWORD_REVEALED",
  "PASSWORD_COPIED",
  "PASSWORD_ROTATED",
  "PASSWORD_VERIFIED",
  "GUAC_CONNECTION_CREATED",
  "GUAC_CONNECTION_DELETED",
  "GUAC_USER_CREATED",
  "GUAC_USER_DELETED",
  "GUAC_ACCESS_GRANTED",
  "GUAC_ACCESS_REVOKED",
  "GUAC_LAUNCHED",
  "USER_CREATED",
  "USER_DELETED",
  "PERMISSION_CHANGED",
  "PROVISIONING_STARTED",
  "PROVISIONING_FAILED",
  "PROVISIONING_RETRIED",
  "PROVISIONING_CANCELLED",
  "ROLLBACK",
  "SETUP_STARTED",
  "SETUP_COMPLETED",
  "SETUP_TEST_PROXMOX",
  "SETUP_TEST_GUACAMOLE",
  "SETUP_TEST_DATABASE",
  "SETTINGS_CHANGED",
  "TEMPLATE_CREATED",
  "TEMPLATE_UPDATED",
  "TEMPLATE_DELETED",
  "CONNECTION_TEST",
  "VM_ACCESS_GRANTED",
  "VM_ACCESS_REVOKED",
  "USER_PERMISSION_GRANTED",
  "USER_PERMISSION_REVOKED",
  "ROLE_CREATED",
  "ROLE_UPDATED",
  "ROLE_DELETED",
  "ROLE_ASSIGNED",
  "ROLE_REMOVED",
  "GROUP_CREATED",
  "GROUP_UPDATED",
  "GROUP_DELETED",
  "GROUP_MEMBER_ADDED",
  "GROUP_MEMBER_REMOVED",
  "GROUP_ROLE_ASSIGNED",
  "GROUP_ROLE_REMOVED",
  "TEMPORARY_ACCESS_GRANTED",
  "TEMPORARY_ACCESS_EXPIRED",
  "VM_PERMISSION_GRANTED",
  "VM_PERMISSION_REVOKED",
  "REGISTRATION_REQUESTED",
  "REGISTRATION_APPROVED",
  "REGISTRATION_REJECTED",
  "SCHEDULE_CREATED",
  "SCHEDULE_DELETED",
  "SCHEDULE_RUN",
  "SHARE_CREATED",
  "SHARE_REVOKED",
  "SHARE_REDEEMED",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export const NETWORK_MODE = ["dhcp", "static"] as const;
export type NetworkMode = (typeof NETWORK_MODE)[number];