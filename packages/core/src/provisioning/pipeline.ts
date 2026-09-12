import type IORedis from "ioredis";
import type { Pool } from "pg";
import type { JobStep, JobStatus, OsType, Protocol, ProvisionVmRequest } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { ProxmoxClient } from "../proxmox/client.js";
import type { GuacamoleDbClient } from "../guacamole/db.js";
import type { GuacamoleApiClient } from "../guacamole/api.js";
import type { SettingsService } from "../services/settings.js";
import type { AuditService } from "../services/audit.js";
import type { VmsRepository } from "../services/vms.js";
import type { CredentialsService } from "../services/credentials.js";
import type { JobsRepository } from "../services/jobs.js";
import type { TemplatesService } from "../services/templates.js";
import type { GuacamoleService } from "../services/guacamole.js";
import { publishProgress } from "../services/progress.js";
import { probeSsh } from "../ssh/client.js";

export class RescheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RescheduleError";
  }
}

export const MAX_WAIT_ATTEMPTS = 30;
export const WAIT_RECHECK_DELAY_MS = 30000;

export interface ProvisioningDeps {
  db: Pool;
  redis: IORedis;
  logger: Logger;
  settings: SettingsService;
  audit: AuditService;
  vms: VmsRepository;
  creds: CredentialsService;
  jobs: JobsRepository;
  templates: TemplatesService;
  guac: GuacamoleService;
  encrypt: (plaintext: string) => string;
  decrypt: (stored: string) => string;
  getProxmoxClient: () => Promise<ProxmoxClient>;
  getGuacDb: () => Promise<GuacamoleDbClient>;
  getGuacApi: () => Promise<GuacamoleApiClient | null>;
}

export type RunOutcome = "COMPLETED" | "RESCHEDULE" | "FAILED" | "SKIPPED";

const STEP_STATUS: Partial<Record<JobStep, JobStatus>> = {
  VALIDATE_PROXMOX_RESOURCES: "CREATING",
  CLONE_TEMPLATE: "CREATING",
  CONFIGURE_VM: "PROVISIONING",
  CONFIGURE_GUEST_PROVISIONING: "PROVISIONING",
  START_VM: "CONFIGURING",
  WAIT_FOR_GUEST: "WAITING_FOR_GUEST",
  DISCOVER_IP: "WAITING_FOR_GUEST",
  VERIFY_GUEST: "VERIFYING",
  VERIFY_CREDENTIALS: "VERIFYING",
  CREATE_GUACAMOLE_CONNECTION: "GUACAMOLE_CREATING",
  VERIFY_GUACAMOLE: "GUACAMOLE_CREATING",
};

export async function runProvisioningJob(deps: ProvisioningDeps, jobId: string, attempt: number): Promise<RunOutcome> {
  const job = await deps.jobs.require(jobId);
  if (job.status === "READY") return "SKIPPED";
  if (job.status === "FAILED" || job.status === "CANCELLED") return "FAILED";
  const rawRequest = job.request as Record<string, unknown>;
  const request = {
    ...rawRequest,
    password: rawRequest.password ? deps.decrypt(String(rawRequest.password)) : "",
  } as unknown as ProvisionVmRequest;
  const completed = await deps.jobs.completedSteps(jobId);

  await deps.jobs.updateStatus(jobId, "PROVISIONING", null);
  await deps.audit.record({
    event: "PROVISIONING_STARTED",
    actorUserId: job.createdByUserId,
    jobId,
    vmId: job.vmId,
    detail: { attempt },
  });

  const stepRunner = new StepRunner(deps, jobId, request, attempt);

  if (job.vmId) {
    const existingVm = await deps.vms.findById(job.vmId);
    if (existingVm) {
      stepRunner.shared.vmRecId = existingVm.id;
      stepRunner.shared.vmid = existingVm.vmid;
      stepRunner.shared.node = existingVm.node;
      if (existingVm.ipAddress) stepRunner.shared.ip = existingVm.ipAddress;
      if (existingVm.templateId) {
        const tmpl = await deps.templates.findById(existingVm.templateId);
        if (tmpl) stepRunner.restoreTemplate(tmpl);
      }
    }
  }

  try {
    // Retry recovery: a previous attempt may have completed VALIDATE_PROXMOX_RESOURCES
    // but failed before the VM record was created (job.vmId still null), leaving
    // StepRunner.template unresolved. Re-resolve it from the job request so
    // CLONE_TEMPLATE does not fail with "Template not resolved".
    if (!stepRunner.isTemplateResolved() && completed.has("VALIDATE_PROXMOX_RESOURCES")) {
      const tmpl = request.templateId
        ? await deps.templates.findById(request.templateId)
        : request.proxmoxTemplateVmid
          ? await deps.templates.findByProxmoxId(request.node ?? (await resolutionNode(deps)), request.proxmoxTemplateVmid)
          : null;
      if (tmpl) {
        stepRunner.restoreTemplate(tmpl);
      } else {
        throw AppError.validation(
          "Template must be registered in ProxVM before it can be used for provisioning. Register it on the Templates page.",
        );
      }
    }

    if (!completed.has("VALIDATE_PROXMOX_RESOURCES")) {
      await stepRunner.run("VALIDATE_PROXMOX_RESOURCES", async () => {
        return stepRunner.validateResources();
      });
    }

    if (!completed.has("CLONE_TEMPLATE")) {
      await stepRunner.run("CLONE_TEMPLATE", async () => {
        return stepRunner.cloneTemplate(job.createdByUserId ?? null);
      });
    }

    if (!completed.has("CONFIGURE_VM")) {
      await stepRunner.run("CONFIGURE_VM", async () => {
        return stepRunner.configureVm();
      });
    }

    if (!completed.has("CONFIGURE_GUEST_PROVISIONING")) {
      await stepRunner.run("CONFIGURE_GUEST_PROVISIONING", async () => {
        return stepRunner.configureGuestProvisioning();
      });
    }

    if (!completed.has("START_VM")) {
      await stepRunner.run("START_VM", async () => {
        return stepRunner.startVm();
      });
    }

    if (!completed.has("WAIT_FOR_GUEST")) {
      await stepRunner.run("WAIT_FOR_GUEST", async () => {
        await stepRunner.waitForGuest(attempt);
      });
    }

    if (!completed.has("DISCOVER_IP")) {
      await stepRunner.run("DISCOVER_IP", async () => {
        await stepRunner.discoverIp(attempt);
      });
    } else {
      const recId = stepRunner.vmRecId();
      if (recId) {
        const rec = await deps.vms.findById(recId);
        if (rec?.ipAddress) stepRunner.shared.ip = rec.ipAddress;
      }
    }

    if (!completed.has("VERIFY_GUEST")) {
      await stepRunner.run("VERIFY_GUEST", async () => {
        return stepRunner.verifyGuest();
      });
    }

    if (!completed.has("VERIFY_CREDENTIALS")) {
      await stepRunner.run("VERIFY_CREDENTIALS", async () => {
        return stepRunner.verifyCredentials();
      });
    }

    if (!completed.has("CREATE_GUACAMOLE_CONNECTION")) {
      await stepRunner.run("CREATE_GUACAMOLE_CONNECTION", async () => {
        return stepRunner.createGuacamoleConnection();
      });
    }

    if (!completed.has("VERIFY_GUACAMOLE")) {
      await stepRunner.run("VERIFY_GUACAMOLE", async () => {
        return stepRunner.verifyGuacamole();
      });
    }

    await deps.jobs.updateStatus(jobId, "READY", null);
    const vmId = stepRunner.vmRecId();
    if (vmId) {
      await deps.vms.updateStatus(vmId, request.startAfterProvision ? "running" : "stopped");
      await deps.creds.markVerified(vmId);
    }
    await publishProgress(deps.redis, jobId, {
      vmId,
      status: "READY",
      step: null,
      error: null,
      progress: 100,
      message: "VM is ready",
    });
    await deps.audit.record({
      event: "VM_CREATED",
      actorUserId: job.createdByUserId,
      jobId,
      vmId,
      detail: { vmid: request.vmid ?? stepRunner.shared.vmid, name: request.name },
    });
    return "COMPLETED";
  } catch (err) {
    if (err instanceof RescheduleError) {
      await publishProgress(deps.redis, jobId, {
        vmId: job.vmId,
        status: "WAITING_FOR_GUEST",
        step: null,
        error: null,
        progress: 55,
        message: err.message,
      });
      return "RESCHEDULE";
    }
    const message = err instanceof Error ? err.message : String(err);
    await deps.jobs.updateStatus(jobId, "FAILED", message);
    await publishProgress(deps.redis, jobId, {
      vmId: job.vmId,
      status: "FAILED",
      step: null,
      error: message,
      progress: 100,
      message: `Provisioning failed: ${message}`,
    });
    await deps.audit.record({
      event: "PROVISIONING_FAILED",
      actorUserId: job.createdByUserId,
      jobId,
      vmId: job.vmId,
      detail: { error: message, attempt },
    });
    deps.logger.error({ jobId, error: message }, "provisioning job failed");
    return "FAILED";
  }
}

interface SharedState {
  templateId: string;
  templateProxmoxVmid: number;
  node: string;
  storage: string;
  vmid: number;
  vmRecId: string | null;
  ip: string | null;
  osName: string | null;
  osType: OsType;
  protocol: Protocol;
  port: number;
  protocols: Protocol[];
}

// The selected access protocols are authoritative: explicit request.protocols
// first, then the template's registered supportedProtocols, then the OS default.
// Never silently fall back to SSH when RDP was explicitly selected.
export function resolveProtocols(
  request: Pick<ProvisionVmRequest, "protocols" | "osType">,
  template: { supportedProtocols: Protocol[] } | null,
): Protocol[] {
  if (request.protocols?.length) return [...new Set(request.protocols)];
  if (template?.supportedProtocols?.length) return [...new Set(template.supportedProtocols)];
  return [request.osType === "windows" ? "rdp" : "ssh"];
}

export function portForProtocol(protocol: Protocol): number {
  if (protocol === "rdp") return 3389;
  if (protocol === "vnc") return 5900;
  return 22;
}

export type VerifyMechanism = "ssh" | "rdp-port" | "vnc-port";

// Guest verification follows the resolved access protocols, not just the OS.
// SSH is verified with real authentication whenever it is among the selected
// protocols; otherwise a transport-level port check matches what the user
// will actually open. Previously every Linux guest was SSH-verified, so an
// RDP-only or VNC-only Linux template without sshd could never provision.
export function selectVerifyMechanism(protocols: Protocol[], osType: OsType): VerifyMechanism {
  if (protocols.includes("ssh")) return "ssh";
  if (osType === "windows" || protocols.includes("rdp")) return "rdp-port";
  return "vnc-port";
}

export function portForVerifyMechanism(mechanism: VerifyMechanism): number {
  if (mechanism === "rdp-port") return 3389;
  if (mechanism === "vnc-port") return 5900;
  return 22;
}

class StepRunner {
  readonly shared: SharedState;
  private template: import("@proxvm/shared").TemplateRecord | null = null;

  constructor(
    private readonly deps: ProvisioningDeps,
    private readonly jobId: string,
    private readonly request: ProvisionVmRequest,
    private readonly attempt: number,
  ) {
    const defaultProtocols = resolveProtocols(this.request, null);
    this.shared = {
      templateId: this.request.templateId ?? "",
      templateProxmoxVmid: this.request.proxmoxTemplateVmid ?? 0,
      node: this.request.node ?? "",
      storage: this.request.storage,
      vmid: this.request.vmid ?? 0,
      vmRecId: null,
      ip: null,
      osName: null,
      osType: this.request.osType,
      protocol: "ssh",
      port: 22,
      protocols: defaultProtocols,
    };
    this.applyProtocols(defaultProtocols);
  }

  vmRecId(): string | null {
    return this.shared.vmRecId;
  }

  isTemplateResolved(): boolean {
    return this.template !== null;
  }

  restoreTemplate(t: import("@proxvm/shared").TemplateRecord): void {
    this.template = t;
    this.shared.templateId = t.id;
    this.shared.templateProxmoxVmid = t.proxmoxVmid;
    this.shared.osType = t.osType;
    this.applyProtocols(resolveProtocols(this.request, t));
  }

  private applyProtocols(protocols: Protocol[]): void {
    const primary = protocols[0] ?? (this.shared.osType === "windows" ? "rdp" : "ssh");
    this.shared.protocols = protocols;
    this.shared.protocol = primary;
    this.shared.port = portForProtocol(primary);
  }

  private async setStep(step: JobStep, state: "RUNNING" | "SUCCEEDED" | "FAILED" | "PENDING" | "SKIPPED", detail?: Record<string, unknown> | null, error?: string | null): Promise<void> {
    await this.deps.jobs.setStep(this.jobId, step, state, detail ?? null, error ?? null);
  }

  async run(step: JobStep, fn: () => Promise<Record<string, unknown> | void>): Promise<void> {
    const status = STEP_STATUS[step] ?? "PROVISIONING";
    await this.deps.jobs.updateStatus(this.jobId, status, null);
    await this.setStep(step, "RUNNING");
    await publishProgress(this.deps.redis, this.jobId, {
      vmId: this.shared.vmRecId,
      status,
      step,
      error: null,
      progress: 0,
      message: `Running ${step}`,
    });
    try {
      const detail = (await fn()) ?? {};
      await this.setStep(step, "SUCCEEDED", detail, null);
      await publishProgress(this.deps.redis, this.jobId, {
        vmId: this.shared.vmRecId,
        status,
        step,
        error: null,
        progress: 100,
        message: `${step} succeeded`,
      });
      this.deps.logger.info({ jobId: this.jobId, step }, "step succeeded");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.setStep(step, "FAILED", null, message);
      this.deps.logger.error({ jobId: this.jobId, step, error: message }, "step failed");
      throw err;
    }
  }

  async validateResources(): Promise<Record<string, unknown>> {
    const proxmox = await this.deps.getProxmoxClient();
    const template = this.request.templateId
      ? await this.deps.templates.requireById(this.request.templateId)
      : this.request.proxmoxTemplateVmid
        ? await this.deps.templates.findByProxmoxId(
            this.request.node ?? (await resolutionNode(this.deps)),
            this.request.proxmoxTemplateVmid,
          )
        : null;
    if (!template) {
      throw AppError.validation(
        "Template must be registered in ProxVM before it can be used for provisioning. Register it on the Templates page.",
      );
    }
    this.template = template;
    this.deps.templates.ensureProvisionable(template);

    const node = this.request.node ?? this.shared.node;
    const nodes = await proxmox.nodes();
    const targetNode = nodes.find((n) => n.node === node);
    if (!targetNode) {
      throw AppError.validation(`Proxmox node "${node}" does not exist`);
    }

    const templates = await proxmox.clusterResources();
    const resource = templates.find((r) => r.vmid === template.proxmoxVmid && r.node === template.node);
    if (!resource) {
      throw AppError.external("Proxmox", `Template ${template.name} (vmid ${template.proxmoxVmid}) no longer exists on node ${template.node}`);
    }
    if (resource.template !== 1) {
      throw AppError.validation(
        `VM ${template.proxmoxVmid} ("${resource.name}") exists on node ${template.node} but is not a template. Convert it to a template or register a different VM.`,
      );
    }

    const storages = await proxmox.storages(node);
    const storage = storages.find((s) => String(s.storage) === this.request.storage);
    if (!storage) {
      throw AppError.external(
        "Proxmox",
        `Storage "${this.request.storage}" not found on node ${node}`,
      );
    }
    const content = String(storage.content ?? "");
    if (!content.includes("images")) {
      throw AppError.external(
        "Proxmox",
        `Storage "${this.request.storage}" cannot hold VM images (content=${content || "none"})`,
      );
    }

    if (this.request.network.bridge) {
      const networks = await proxmox.networks(node);
      const bridge = networks.find((n) => String(n.iface) === this.request.network.bridge);
      if (!bridge) {
        throw AppError.external(
          "Proxmox",
          `Network bridge "${this.request.network.bridge}" not found on node ${node}`,
        );
      }
    }

    this.shared.node = node;
    this.shared.templateId = template.id;
    this.shared.templateProxmoxVmid = template.proxmoxVmid;
    this.shared.osType = template.osType;
    this.applyProtocols(resolveProtocols(this.request, template));
    return {
      node,
      storage: this.request.storage,
      templateId: template.id,
      templateVmid: template.proxmoxVmid,
      osType: template.osType,
    };
  }

  async cloneTemplate(createdByUserId: string | null): Promise<Record<string, unknown>> {
    const proxmox = await this.deps.getProxmoxClient();
    if (!this.template) throw AppError.validation("Template not resolved");
    let vmid = this.request.vmid ?? 0;
    if (!vmid) {
      vmid = await proxmox.nextId();
      // Proxmox nextid is cluster max+1 and knows nothing of ProxVM's
      // soft-deleted rows, which still occupy UNIQUE(vmid, node). Advance
      // past any VMID that is tracked (live or deleted) or present in the
      // cluster, instead of crashing on a unique violation at insert time.
      const taken = new Set(await this.deps.vms.listVmidsByNode(this.shared.node));
      if (taken.has(vmid)) {
        const resources = await proxmox.clusterResources();
        const used = new Set(resources.map((r) => r.vmid));
        let guard = 0;
        while ((taken.has(vmid) || used.has(vmid)) && guard++ < 1000) vmid += 1;
        if (guard >= 1000) {
          throw AppError.conflict(
            `No free VM ID found on node ${this.shared.node} after 1000 attempts.`,
          );
        }
      }
    }
    const existing = await this.deps.vms.findByIdKey(vmid, this.shared.node);
    if (existing) {
      throw AppError.conflict(
        `VM ID ${vmid} on node ${this.shared.node} is already tracked. Choose a different VM ID.`,
      );
    }
    const isFullClone = !this.request.linkedClone;
    const upid = await proxmox.clone({
      node: this.template.node,
      templateVmid: this.template.proxmoxVmid,
      newVmid: vmid,
      name: this.request.name,
      full: isFullClone,
      // Proxmox rejects "storage" ("parameter 'storage' not allowed for linked clones")
      // and only honors "target" for full clones — linked clones must stay on the
      // template's own storage.
      ...(isFullClone ? { storage: this.request.storage, target: this.shared.node } : {}),
    });
    this.shared.vmid = vmid;
    this.deps.logger.info({ vmid, upid }, "clone started");
    await proxmox.waitForTask(this.template.node, upid, 900000);
    const vmRecord = await this.deps.vms.findOrCreate({
      vmid,
      node: this.shared.node,
      name: this.request.name,
      status: "pending",
      osType: this.shared.osType,
      createdByUserId: createdByUserId ?? undefined,
      templateId: this.shared.templateId,
    });
    this.shared.vmRecId = vmRecord.id;
    await this.deps.jobs.setVmId(this.jobId, vmRecord.id);
    await this.deps.jobs.updateStatus(this.jobId, "CREATING", null);
    return { vmid, node: this.shared.node, upid };
  }

  async configureVm(): Promise<Record<string, unknown>> {
    const proxmox = await this.deps.getProxmoxClient();
    const cfg = await proxmox.qemuConfig(this.shared.node, this.shared.vmid);
    const updates: Record<string, unknown> = {
      memory: this.request.ramMb,
      cores: this.request.cpu,
      sockets: 1,
      agent: "enabled=1,fstrim_cloned_disks=1",
    };
    const netKey = netIndex(cfg);
    if (netKey) {
      const existing = parseNet(cfg[netKey]);
      updates[netKey] = buildNet(
        existing.model,
        existing.macaddr,
        this.request.network.bridge,
        this.request.network.vlan,
        extraNetOptions(typeof cfg[netKey] === "string" ? (cfg[netKey] as string) : null, existing.model),
      );
    }
    const upid = await proxmox.updateConfig(this.shared.node, this.shared.vmid, updates);
    if (upid) await proxmox.waitForTask(this.shared.node, upid, 120000);

    const diskKey = rootDisk(cfg);
    const requestedBytes = this.request.diskGb * 1024 ** 3;
    if (diskKey && cfg[diskKey] && diskSizeOf(String(cfg[diskKey])) !== null && (diskSizeOf(String(cfg[diskKey])) ?? 0) < requestedBytes) {
      const resizeUpid = await proxmox.resizeDisk(this.shared.node, this.shared.vmid, diskKey, `${this.request.diskGb}G`);
      if (resizeUpid) await proxmox.waitForTask(this.shared.node, resizeUpid, 300000);
    }
    return { memory: this.request.ramMb, cores: this.request.cpu, net: netKey ?? "n/a", disk: diskKey ?? "n/a" };
  }

  async configureGuestProvisioning(): Promise<Record<string, unknown>> {
    const proxmox = await this.deps.getProxmoxClient();
    const cfg = await proxmox.qemuConfig(this.shared.node, this.shared.vmid);
    const cloudInitDrive = Object.entries(cfg).find(
      ([, v]) => typeof v === "string" && v.includes("cloudinit"),
    );
    if (!cloudInitDrive) {
      throw AppError.external(
        "Proxmox",
        `Template must include a cloud-init drive. Current config has no "cloudinit" drive.`,
      );
    }
    let ipconfig0 = "ip=dhcp";
    if (this.request.network.mode === "static") {
      if (!this.request.network.ip || !this.request.network.gateway) {
        throw AppError.validation("Static networking requires both IP and gateway");
      }
      const cidr = this.request.network.cidr ?? 24;
      ipconfig0 = `ip=${this.request.network.ip}/${cidr},gw=${this.request.network.gateway}`;
    }
    const config: Record<string, unknown> = {
      ciuser: this.request.guestUser,
      cipassword: this.request.password,
      ipconfig0,
      ciupgrade: 0,
    };
    if (this.request.network.mode === "static" && this.request.network.dns?.length) {
      config.nameserver = this.request.network.dns.join(" ");
    }
    await proxmox.setCloudInitConfig(this.shared.node, this.shared.vmid, config);

    await this.deps.creds.store(this.shared.vmRecId as string, this.request.guestUser, this.request.password, "PROVISIONED");
    await this.deps.audit.record({
      event: "PASSWORD_CREATED",
      actorUserId: null,
      jobId: this.jobId,
      vmId: this.shared.vmRecId,
      detail: { username: this.request.guestUser, mechanism: "cloud-init" },
    });
    return { ciuser: this.request.guestUser, ipconfig0, drive: cloudInitDrive[0] };
  }

  async startVm(): Promise<Record<string, unknown>> {
    const proxmox = await this.deps.getProxmoxClient();
    if (!this.request.startAfterProvision) {
      return { started: false };
    }
    const upid = await proxmox.start(this.shared.node, this.shared.vmid);
    if (upid) await proxmox.waitForTask(this.shared.node, upid, 120000);
    const status = await proxmox.qemuStatus(this.shared.node, this.shared.vmid);
    if (String(status.status) !== "running") {
      throw AppError.external("Proxmox", `VM did not reach running state (status=${String(status.status)})`);
    }
    if (this.shared.vmRecId) await this.deps.vms.updateStatus(this.shared.vmRecId, "running");
    return { started: true, status: String(status.status) };
  }

  async waitForGuest(attempt: number): Promise<void> {
    const template = this.template as import("@proxvm/shared").TemplateRecord;
    const proxmox = await this.deps.getProxmoxClient();
    if (!this.request.startAfterProvision) return;
    const windowMs = 120000;
    const agentReady = await proxmox.waitForGuestAgent(this.shared.node, this.shared.vmid, windowMs, 5000);
    if (!agentReady) {
      if (attempt >= MAX_WAIT_ATTEMPTS) {
        throw new AppError(
          "PROVISIONING_ERROR",
          template.guestAgentRequired
            ? "Guest agent never became available. Ensure qemu-guest-agent is installed in the template and the VM boots correctly."
            : "VM did not boot to a reachable state within the allowed time.",
          504,
        );
      }
      throw new RescheduleError("WAITING FOR GUEST IP");
    }
    void attempt;
  }

  async discoverIp(attempt: number): Promise<Record<string, unknown>> {
    const proxmox = await this.deps.getProxmoxClient();
    let ip: string | null = null;
    let source = "";
    if (!this.request.startAfterProvision) {
      if (this.request.network.mode === "static" && this.request.network.ip) {
        ip = this.request.network.ip;
        source = "static_config";
      }
    } else {
      const agent = await proxmox.guestIpAddresses(this.shared.node, this.shared.vmid);
      if (!agent) {
        this.deps.logger.info({ vmid: this.shared.vmid }, "guest agent not reachable yet");
      }
      if (agent) {
        const candidate = selectUsableIpv4(agent.ipv4s);
        if (candidate) {
          ip = candidate;
          source = "guest_agent";
        } else {
          this.deps.logger.info({ vmid: this.shared.vmid, interfaces: agent.interfaces }, "guest agent reachable but no usable LAN IPv4 yet");
        }
        if (this.shared.vmRecId) {
          let osLabel = agent.osType;
          if (!osLabel) {
            const osinfo = await proxmox.agentOsInfo(this.shared.node, this.shared.vmid);
            osLabel = osinfo?.prettyName ?? null;
          }
          if (osLabel) {
            await this.deps.vms.updateOsInfo(this.shared.vmRecId, osLabel);
            this.shared.osName = osLabel;
          }
        }
      }
      if (!ip && this.request.network.mode === "static" && this.request.network.ip) {
        ip = this.request.network.ip;
        source = "static_config";
      }
    }
    if (!ip) {
      if (attempt >= MAX_WAIT_ATTEMPTS) {
        throw new AppError(
          "PROVISIONING_ERROR",
          "IP address could not be discovered. The guest agent reported no usable IPv4 address and no static address was configured.",
          504,
        );
      }
      throw new RescheduleError("WAITING FOR GUEST IP");
    }
    this.shared.ip = ip;
    if (this.shared.vmRecId) await this.deps.vms.updateIp(this.shared.vmRecId, ip);
    return { ip, source };
  }

  async verifyGuest(): Promise<Record<string, unknown>> {
    const mechanism = selectVerifyMechanism(this.shared.protocols, this.shared.osType);
    if (mechanism === "ssh") {
      const result = await probeSsh({
        host: this.shared.ip as string,
        port: 22,
        username: this.request.guestUser,
        password: this.request.password,
      });
      if (result.status !== "AUTHENTICATED") {
        throw AppError.external(
          "SSH",
          `Guest is reachable at ${this.shared.ip} but credentials were rejected: ${result.detail}`,
        );
      }
      return { mechanism: "ssh", hostname: result.output };
    }
    const port = portForVerifyMechanism(mechanism);
    const reachable = await probeTcp(this.shared.ip as string, port, 10000);
    if (!reachable) {
      throw AppError.external("Guest", `Guest port ${port} is not reachable on ${this.shared.ip}`);
    }
    return { mechanism, reachable: true };
  }

  async verifyCredentials(): Promise<Record<string, unknown>> {
    const mechanism = selectVerifyMechanism(this.shared.protocols, this.shared.osType);
    if (mechanism === "ssh") {
      const result = await probeSsh({
        host: this.shared.ip as string,
        port: 22,
        username: this.request.guestUser,
        password: this.request.password,
      });
      if (result.status !== "AUTHENTICATED") {
        await this.deps.creds.setStatus(this.shared.vmRecId as string, "FAILED");
        throw AppError.external(
          "SSH",
          `Credential verification failed for ${this.shared.ip}: ${result.detail}`,
        );
      }
      await this.deps.creds.setStatus(this.shared.vmRecId as string, "VERIFIED");
      await this.deps.audit.record({
        event: "PASSWORD_VERIFIED",
        actorUserId: null,
        jobId: this.jobId,
        vmId: this.shared.vmRecId,
        detail: { mechanism: "ssh", username: this.request.guestUser },
      });
      return { verified: true, mechanism: "ssh" };
    }
    const port = portForVerifyMechanism(mechanism);
    const reachable = await probeTcp(this.shared.ip as string, port, 10000);
    if (!reachable) {
      throw AppError.external("Guest", `Guest port ${port} is not reachable on ${this.shared.ip}`);
    }
    await this.deps.creds.setStatus(this.shared.vmRecId as string, "PROVISIONED");
    return { verified: false, mechanism, note: "Credential check passed at the transport level; full authentication verification happens when the connection is opened." };
  }

  async createGuacamoleConnection(): Promise<Record<string, unknown>> {
    const guacDb = await this.deps.getGuacDb();
    const vmRec = await this.deps.vms.requireById(this.shared.vmRecId as string);
    const multi = this.shared.protocols.length > 1;
    const created: Array<{ protocol: Protocol; guacConnectionName: string; port: number }> = [];
    for (const protocol of this.shared.protocols) {
      const { record } = await this.deps.guac.upsertConnection({
        vmId: vmRec.id,
        vmName: vmRec.name,
        protocol,
        hostname: this.shared.ip as string,
        port: portForProtocol(protocol),
        username: this.request.guestUser,
        password: this.request.password,
        guacDb,
        connectionName: multi ? `proxvm-${vmRec.name}-${protocol}` : undefined,
      });
      created.push({ protocol, guacConnectionName: record.guac_connection_name, port: portForProtocol(protocol) });
    }
    const { UsersService } = await import("../services/users.js");
    const users = new UsersService(this.deps.db);
    for (const userId of this.request.assignToUserIds ?? []) {
      const user = await users.findById(userId);
      if (!user) continue;
      await this.deps.guac.ensureGuacUser(user.id, user.username, guacDb);
      await this.deps.guac.grantVmAccess(vmRec.id, user.id, guacDb);
      await this.deps.vms.setAccess(vmRec.id, user.id);
      await this.deps.audit.record({
        event: "VM_ACCESS_GRANTED",
        actorUserId: null,
        jobId: this.jobId,
        vmId: vmRec.id,
        detail: { userId, username: user.username },
      });
    }
    if (!this.request.assignToUserIds?.length && vmRec.createdByUserId) {
      const creator = await users.findById(vmRec.createdByUserId);
      if (creator && creator.roles.some((r) => r !== "USER")) {
        await this.deps.guac.ensureGuacUser(creator.id, creator.username, guacDb);
        await this.deps.guac.grantVmAccess(vmRec.id, creator.id, guacDb);
        await this.deps.vms.setAccess(vmRec.id, creator.id);
      }
    }
    await this.deps.audit.record({
      event: "GUAC_CONNECTION_CREATED",
      actorUserId: null,
      jobId: this.jobId,
      vmId: vmRec.id,
      detail: { protocols: this.shared.protocols, hostname: this.shared.ip },
    });
    return { guacConnections: created, protocols: this.shared.protocols };
  }

  async verifyGuacamole(): Promise<Record<string, unknown>> {
    const guacDb = await this.deps.getGuacDb();
    const vmRec = await this.deps.vms.requireById(this.shared.vmRecId as string);
    const records = await this.deps.guac.listConnectionRecords(vmRec.id);
    if (!records.length) throw AppError.external("Guacamole", "Connection record missing");
    const results: Array<{ protocol: string; ok: boolean; detail: string }> = [];
    for (const record of records) {
      const check = await this.deps.guac.verifyConnection(record, guacDb);
      results.push({ protocol: record.protocol, ok: check.ok, detail: check.detail });
      if (!check.ok) {
        await this.deps.db.query(
          "UPDATE guacamole_connections SET status = 'FAILED', updated_at = NOW() WHERE id = $1",
          [record.id],
        );
        throw AppError.external("Guacamole", `Guacamole verification failed (${record.protocol}): ${check.detail}`);
      }
      await this.deps.db.query(
        `UPDATE guacamole_connections SET status = 'ACTIVE', last_verified_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [record.id],
      );
    }
    return { ok: true, results };
  }
}

async function resolutionNode(deps: ProvisioningDeps): Promise<string> {
  const s = await deps.settings.proxmox();
  if (s?.defaultNode) return s.defaultNode;
  const proxmox = await deps.getProxmoxClient();
  const nodes = await proxmox.nodes();
  return nodes[0]?.node ?? "";
}

export function selectUsableIpv4(addresses: string[]): string | null {
  return (
    addresses.find(
      (a) =>
        /^\d+\.\d+\.\d+\.\d+$/.test(a) &&
        !a.startsWith("127.") &&
        !a.startsWith("169.254.") &&
        !a.startsWith("0.") &&
        a.split(".")[0] !== "255",
    ) ?? null
  );
}

function netIndex(cfg: import("@proxvm/shared").ProxmoxVmConfig): string | null {
  for (let i = 0; i < 32; i++) {
    const key = `net${i}`;
    if (cfg[key] !== undefined) return key;
  }
  return null;
}

interface ParsedNet {
  model: string;
  macaddr: string | null;
  bridge: string | null;
}

function parseNet(value: unknown): ParsedNet {
  const str = String(value ?? "");
  const parts = str.split(",");
  const first = parts[0] ?? "";
  const eq = first.indexOf("=");
  let model = "virtio";
  let macaddr: string | null = null;
  if (eq >= 0) {
    model = first.slice(0, eq) || "virtio";
    macaddr = first.slice(eq + 1) || null;
  } else if (first) {
    model = first;
  }
  let bridge: string | null = null;
  for (const part of parts) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i);
    const v = part.slice(i + 1);
    if (k === "bridge") bridge = v;
    if (k === "model") model = v;
  }
  return { model, macaddr, bridge };
}

export function buildNet(model: string, macaddr: string | null, bridge: string, vlan?: number, extra?: string[]): string {
  const first = macaddr ? `${model}=${macaddr}` : model;
  return [first, `bridge=${bridge}${vlan ? `,tag=${vlan}` : ""}`, ...(extra ?? [])].join(",");
}

/** Extra NIC options carried over from the template's own config (firewall,
 *  mtu, queues, ...). Only bridge/tag are managed by provisioning, so every
 *  other option is preserved instead of being silently dropped. */
export function extraNetOptions(raw: string | null | undefined, model: string): string[] {
  const out: string[] = [];
  for (const part of String(raw ?? "").split(",")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const key = i < 0 ? part : part.slice(0, i);
    if (key === "bridge" || key === "tag" || key === "model" || key === "macaddr") continue;
    if (part === model || part.startsWith(`${model}=`)) continue;
    out.push(part);
  }
  return out;
}

function rootDisk(cfg: import("@proxvm/shared").ProxmoxVmConfig): string | null {
  for (const key of ["scsi0", "virtio0", "ide0", "sata0"]) {
    if (cfg[key] !== undefined) return key;
  }
  return null;
}

function diskSizeOf(value: string): number | null {
  const match = /size=(\d+(?:\.\d+)?)([KMG]?)/i.exec(value);
  if (!match) return null;
  const num = Number(match[1]);
  const unit = (match[2] ?? "G").toUpperCase();
  if (unit === "K") return num * 1024;
  if (unit === "M") return num * 1024 ** 2;
  return num * 1024 ** 3;
}

export async function probeTcp(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}