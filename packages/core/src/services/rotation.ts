import type { Pool } from "pg";
import { AppError } from "../util/errors.js";
import { generatePassword } from "../crypto/password.js";
import { probeSsh, runSshCommand } from "../ssh/client.js";
import { probeTcp } from "../provisioning/pipeline.js";
import type { CredentialsService } from "./credentials.js";
import type { GuacamoleService } from "./guacamole.js";
import type { VmsRepository } from "./vms.js";
import type { AuditService } from "./audit.js";
import type { SettingsService } from "./settings.js";
import type { ProxmoxClient } from "../proxmox/client.js";
import type { GuacamoleDbClient } from "../guacamole/db.js";
import type { Logger } from "../util/logger.js";

export interface RotationDeps {
  db: Pool;
  logger: Logger;
  settings: SettingsService;
  vms: VmsRepository;
  creds: CredentialsService;
  guac: GuacamoleService;
  audit: AuditService;
  decrypt: (stored: string) => string;
  getProxmoxClient: () => Promise<ProxmoxClient>;
  getGuacDb: () => Promise<GuacamoleDbClient>;
}

export interface RotationResult {
  success: boolean;
  mechanism: string;
  verified: boolean;
  details: string;
}

export interface RotationOptions {
  newPassword?: string;
  username?: string;
  verify?: boolean;
}

export interface RotationActor {
  userId: string;
  username: string;
}

export async function rotateVmCredential(
  deps: RotationDeps,
  vmId: string,
  opts: RotationOptions,
  actor: RotationActor,
): Promise<RotationResult> {
  const vm = await deps.vms.requireById(vmId);
  const existing = await deps.creds.findByVm(vmId);
  if (!existing) throw AppError.notFound("No credential stored for this VM");
  if (!vm.ipAddress) {
    throw AppError.validation(
      "VM has no known IP address. Credential rotation requires a reachable guest.",
    );
  }
  if (vm.status !== "running" && vm.osType === "linux") {
    throw AppError.validation("VM must be running to rotate a credential online");
  }
  const username = opts.username ?? existing.username;
  const oldPassword = deps.decrypt(existing.password_ciphertext);
  const newPassword = opts.newPassword ?? generatePassword(24);

  await deps.creds.setStatus(vmId, "ROTATING");

  const proxmox = await deps.getProxmoxClient();
  const attempts: Array<() => Promise<{ success: boolean; message: string }>> =
    vm.osType === "windows"
      ? [
          () => rotateViaGuestAgent(deps, proxmox, vm.node, vm.vmid, username, newPassword),
        ]
      : [
          () => rotateViaSsh(vm.ipAddress as string, username, oldPassword, newPassword),
          () => rotateViaGuestAgent(deps, proxmox, vm.node, vm.vmid, username, newPassword),
        ];

  let applied: { success: boolean; message: string } | null = null;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result.success) {
        applied = result;
        break;
      }
    } catch (err) {
      deps.logger.warn({ vmId, error: err instanceof Error ? err.message : String(err) }, "rotation mechanism failed");
    }
  }
  if (!applied || !applied.success) {
    // The guest was never modified and the stored credential is untouched:
    // restore the prior status instead of claiming VERIFIED, so the UI does
    // not report a successful rotation that never happened.
    await deps.creds.setStatus(vmId, existing.status);
    await deps.audit.record({
      event: "PASSWORD_ROTATED",
      actorUserId: actor.userId,
      actorUsername: actor.username,
      vmId,
      detail: { result: "failed", mechanism: "none-applied" },
    });
    throw AppError.external(
      "Guest",
      `Failed to apply the new password on the guest. The previous credential remains in use. Reasons: ${applied?.message ?? "all mechanisms failed"}`,
    );
  }

  const verify = opts.verify !== false;
  let verified = false;
  if (verify) {
    if (vm.osType === "windows") {
      verified = await probeTcp(vm.ipAddress, 3389, 8000);
    } else {
      const result = await probeSsh({
        host: vm.ipAddress,
        port: 22,
        username,
        password: newPassword,
      });
      verified = result.status === "AUTHENTICATED";
      if (!verified) {
        await rotateViaSsh(vm.ipAddress as string, username, newPassword, oldPassword).catch(() => undefined);
        await deps.creds.store(vmId, existing.username, oldPassword, "VERIFIED");
        await deps.creds.setStatus(vmId, "VERIFIED");
        await deps.audit.record({
          event: "PASSWORD_ROTATED",
          actorUserId: actor.userId,
          actorUsername: actor.username,
          vmId,
          detail: { result: "rolled-back", reason: `verification failed: ${result.detail}` },
        });
        throw AppError.external(
          "Guest",
          `New credential failed verification (${result.detail}). The previous credential was restored.`,
        );
      }
    }
  }

  await deps.creds.rotate(vmId, username, newPassword);
  if (verified) {
    await deps.creds.markRotatedSuccess(vmId);
  } else {
    await deps.creds.setStatus(vmId, "PROVISIONED");
  }

  try {
    const guacDb = await deps.getGuacDb();
    await deps.guac.updateConnectionPassword(vmId, newPassword, guacDb);
  } catch (err) {
    deps.logger.error({ vmId, error: err instanceof Error ? err.message : String(err) }, "failed to update Guacamole connection password");
  }

  await deps.audit.record({
    event: "PASSWORD_ROTATED",
    actorUserId: actor.userId,
    actorUsername: actor.username,
    vmId,
    detail: { result: "success", mechanism: applied.message, verified },
  });
  return {
    success: true,
    mechanism: applied.message,
    verified,
    details: vm.osType === "windows" ? "Transport-level check only; RDP authentication is verified when opened" : "SSH authentication verified",
  };
}

async function rotateViaSsh(
  host: string,
  username: string,
  oldPassword: string,
  newPassword: string,
): Promise<{ success: boolean; message: string }> {
  const encrypted = shellQuote(username) + ":" + shellQuote(newPassword);
  const command = `echo '${encrypted}' | sudo -n chpasswd 2>/dev/null || echo '${encrypted}' | chpasswd`;
  const result = await runSshCommand({ host, username, password: oldPassword, command });
  if (result.status !== "AUTHENTICATED") {
    return { success: false, message: `ssh: ${result.detail}` };
  }
  if (!result.output || /permission denied|not in the sudoers|chpasswd: .*error/i.test(result.output)) {
    return { success: false, message: `ssh-chpasswd rejected: ${result.output?.slice(0, 120) ?? "no output"}` };
  }
  return { success: true, message: "ssh-chpasswd" };
}

async function rotateViaGuestAgent(
  deps: RotationDeps,
  proxmox: ProxmoxClient,
  node: string,
  vmid: number,
  username: string,
  newPassword: string,
): Promise<{ success: boolean; message: string }> {
  const osType = (await deps.vms.findByIdKey(vmid, node))?.osType;
  let command: string;
  if (osType === "windows") {
    // net.exe arguments are interpolated into a guest shell command line.
    // Double-quoting is safe for direct execution and for cmd.exe except for
    // embedded quotes and %-wrapping (environment expansion), which are
    // rejected with a clear error instead of risking command injection.
    const problem = windowsPasswordError(newPassword);
    if (problem) return { success: false, message: `windows-password: ${problem}` };
    command = `net user ${quoteWindowsArg(username)} ${quoteWindowsArg(newPassword)}`;
  } else {
    command = `echo '${shellQuote(username)}:${shellQuote(newPassword)}' | chpasswd`;
  }
  try {
    const result = await proxmox.startAgentExecAndWait(node, vmid, command, 60000);
    if (result.exitCode !== 0) {
      return { success: false, message: `guest-agent exit ${String(result.exitCode)}: ${result.stderr.slice(0, 120)}` };
    }
    return { success: true, message: "guest-agent" };
  } catch (err) {
    return { success: false, message: `guest-agent: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function shellQuote(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw AppError.validation("Value contains line breaks and cannot be safely quoted for shell use");
  }
  return value.replace(/'/g, `'\\''`);
}

export function quoteWindowsArg(value: string): string {
  return `"${value}"`;
}

/** Non-null when a password cannot be passed to `net user` safely. Exported for tests. */
export function windowsPasswordError(password: string): string | null {
  if (/["\r\n]/.test(password)) {
    return 'password contains " or line breaks, which cannot be passed to net user safely; choose another password';
  }
  if (/%[^%]*%/.test(password)) {
    return "password contains %-wrapping, which cmd.exe would expand; choose another password";
  }
  return null;
}