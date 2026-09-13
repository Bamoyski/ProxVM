import https from "node:https";
import http from "node:http";
import type { ProxmoxAgentInfo, ProxmoxNodeStatus, ProxmoxQemuResource, ProxmoxVmConfig } from "@proxvm/shared";
import { stripTrailingSlashes } from "../util/misc.js";

export class ProxmoxApiError extends Error {
  readonly statusCode: number;
  readonly errors: Record<string, unknown> | null;
  readonly detail: Record<string, unknown> | null;

  constructor(message: string, statusCode: number, errors: Record<string, unknown> | null, detail: Record<string, unknown> | null = null) {
    super(message);
    this.name = "ProxmoxApiError";
    this.statusCode = statusCode;
    this.errors = errors;
    this.detail = detail;
  }
}

export interface ProxmoxClientOptions {
  url: string;
  tokenId: string;
  tokenSecret: string;
  verifySsl: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ProxmoxTaskStatus {
  upid: string;
  status: string;
  exitstatus: string | null;
  type: string | null;
}

interface HttpResult {
  status: number;
  text: string;
}

function nodeHttpRequest(
  target: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    rejectUnauthorized: boolean;
    timeoutMs: number;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const request = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? "443" : "80"),
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        headers: opts.headers,
        rejectUnauthorized: opts.rejectUnauthorized,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(opts.timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${opts.timeoutMs}ms`));
    });
    request.on("error", reject);
    if (opts.body !== undefined) request.write(opts.body);
    request.end();
  });
}

export class ProxmoxClient {
  private readonly baseUrl: string;
  private readonly tokenId: string;
  private readonly tokenSecret: string;
  private readonly verifySsl: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | null;

  constructor(opts: ProxmoxClientOptions) {
    this.baseUrl = stripTrailingSlashes(opts.url);
    this.tokenId = opts.tokenId;
    this.tokenSecret = opts.tokenSecret;
    this.verifySsl = opts.verifySsl;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.fetchImpl = opts.fetchImpl ?? null;
  }

  private headers(body?: unknown): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      const serialized = JSON.stringify(body);
      h["Content-Type"] = "application/json";
      h["Content-Length"] = String(Buffer.byteLength(serialized));
    }
    return h;
  }

  private async httpRequest(path: string, init?: { method?: string; body?: unknown }): Promise<HttpResult> {
    const method = init?.method ?? "GET";
    const serialized = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
    const headers = this.headers(init?.body);
    if (!this.fetchImpl) {
      try {
        return await nodeHttpRequest(`${this.baseUrl}/api2/json${path}`, {
          method,
          headers,
          body: serialized,
          rejectUnauthorized: this.verifySsl,
          timeoutMs: this.timeoutMs,
        });
      } catch (err) {
        // Transport-level failure (DNS, connect, TLS, timeout). The message
        // stays free of hostnames/URLs (it reaches normal users via VM/job
        // error surfaces); structured context lives in `detail` for logs and
        // privileged 502 responses.
        const url = new URL(this.baseUrl);
        throw new ProxmoxApiError(
          "Cannot reach the Proxmox API. The host may be down, unreachable, or rejecting TLS.",
          0,
          null,
          {
            hostname: url.hostname,
            port: url.port || "443",
            method,
            path,
            timeoutMs: this.timeoutMs,
            cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          },
        );
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api2/json${path}`, {
        method,
        headers,
        body: serialized,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { status: response.status, text: await response.text() };
    } catch (err) {
      clearTimeout(timer);
      const url = new URL(this.baseUrl);
      throw new ProxmoxApiError(
        "Cannot reach the Proxmox API. The host may be down, unreachable, or rejecting the request.",
        0,
        null,
        {
          hostname: url.hostname,
          port: url.port || "443",
          method,
          path,
          timeoutMs: this.timeoutMs,
          cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
      );
    }
  }

  async request<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const result = await this.httpRequest(path, init);
    let json: { data?: T; errors?: Record<string, unknown> } | null = null;
    try {
      json = JSON.parse(result.text) as { data?: T; errors?: Record<string, unknown> } | null;
    } catch {
      throw new ProxmoxApiError(
        `Proxmox API returned a non-JSON response (HTTP ${result.status}): ${result.text.slice(0, 200).trim() || "(empty body)"}`,
        result.status,
        null,
        { upstreamStatus: result.status, baseUrl: this.baseUrl, path, method: init?.method ?? "GET" },
      );
    }
    if (json && json.errors && Object.keys(json.errors).length > 0) {
      const msg = Object.entries(json.errors)
        .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join("; ");
      throw new ProxmoxApiError(msg, result.status, json.errors);
    }
    if (result.status < 200 || result.status >= 300) {
      const upstreamMessage =
        json && typeof (json as { message?: unknown }).message === "string"
          ? (json as { message: string }).message.trim()
          : null;
      throw new ProxmoxApiError(
        `Proxmox API HTTP ${result.status}${upstreamMessage ? `: ${upstreamMessage}` : ""}`,
        result.status,
        null,
        { upstreamStatus: result.status, baseUrl: this.baseUrl, path, method: init?.method ?? "GET" },
      );
    }
    return (json?.data ?? null) as T;
  }

  async version(): Promise<{ version: string; release: string; repoid: string }> {
    return this.request<{ version: string; release: string; repoid: string }>("/version");
  }

  async nodes(): Promise<Array<{ node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; uptime: number; pveversion: string }>> {
    return this.request("/nodes");
  }

  async nodeStatus(): Promise<ProxmoxNodeStatus[]> {
    const nodes = await this.nodes();
    return nodes.map((n) => ({
      node: n.node,
      status: (n.status as "online" | "offline") ?? "unknown",
      cpu: n.cpu ?? null,
      maxcpu: n.maxcpu,
      memUsed: n.mem ?? null,
      memTotal: n.maxmem ?? null,
      uptime: n.uptime ?? null,
      pveVersion: n.pveversion ?? null,
    }));
  }

  async clusterResources(): Promise<ProxmoxQemuResource[]> {
    const resources = await this.request<Array<Record<string, unknown>>>("/cluster/resources?type=vm");
    const out: ProxmoxQemuResource[] = [];
    for (const r of resources) {
      out.push({
        vmid: Number(r.vmid),
        node: String(r.node ?? ""),
        name: String(r.name ?? ""),
        status: (r.status as "running" | "stopped" | "paused") ?? "stopped",
        template: Number(r.template ?? 0) === 1 ? 1 : 0,
        maxcpu: Number(r.maxcpu ?? 0),
        cpu: r.cpu === undefined || r.cpu === null ? null : Number(r.cpu),
        mem: r.mem === undefined || r.mem === null ? null : Number(r.mem),
        maxmem: Number(r.maxmem ?? 0),
        maxdisk: Number(r.maxdisk ?? 0),
        disk: r.disk === undefined || r.disk === null ? null : Number(r.disk),
        uptime: r.uptime === undefined || r.uptime === null ? null : Number(r.uptime),
        netin: r.netin === undefined || r.netin === null ? null : Number(r.netin),
        netout: r.netout === undefined || r.netout === null ? null : Number(r.netout),
        vcpus: r.vcpus === undefined ? undefined : Number(r.vcpus),
        diskread: r.diskread === undefined || r.diskread === null ? null : Number(r.diskread),
        diskwrite: r.diskwrite === undefined || r.diskwrite === null ? null : Number(r.diskwrite),
      });
    }
    return out;
  }

  async qemuStatus(node: string, vmid: number): Promise<Record<string, unknown>> {
    return this.request(`/nodes/${node}/qemu/${vmid}/status/current`);
  }

  async qemuConfig(node: string, vmid: number): Promise<ProxmoxVmConfig> {
    return this.request<ProxmoxVmConfig>(`/nodes/${node}/qemu/${vmid}/config`);
  }

  async templates(): Promise<ProxmoxQemuResource[]> {
    const resources = await this.clusterResources();
    return resources.filter((r) => r.template === 1);
  }

  async storages(node?: string): Promise<Array<Record<string, unknown>>> {
    if (node) return this.request(`/nodes/${node}/storage`);
    const nodes = await this.nodes();
    const all: Array<Record<string, unknown>> = [];
    for (const n of nodes) {
      try {
        const storages = await this.request<Array<Record<string, unknown>>>(`/nodes/${n.node}/storage`);
        all.push(...storages.map((s) => ({ ...s, node: n.node })));
      } catch {
        continue;
      }
    }
    return all;
  }

  async networks(node: string): Promise<Array<Record<string, unknown>>> {
    return this.request(`/nodes/${node}/network`);
  }

  async nextId(): Promise<number> {
    const result = await this.request<number | string>("/cluster/nextid");
    const value = Number(result);
    if (!Number.isFinite(value) || value <= 0) {
      throw new ProxmoxApiError(
        `Proxmox did not return a valid next VM ID (got: ${String(result)})`,
        502,
        null,
      );
    }
    return value;
  }

  async clone(opts: {
    node: string;
    templateVmid: number;
    newVmid: number;
    name?: string;
    storage?: string;
    full?: boolean;
    target?: string;
  }): Promise<string> {
    const result = await this.request<string>(`/nodes/${opts.node}/qemu/${opts.templateVmid}/clone`, {
      method: "POST",
      body: {
        newid: opts.newVmid,
        name: opts.name,
        storage: opts.storage,
        full: opts.full ?? false,
        target: opts.target,
      },
    });
    return typeof result === "string" ? result : "";
  }

  async updateConfig(node: string, vmid: number, config: Record<string, unknown>): Promise<string> {
    const result = await this.request<string>(`/nodes/${node}/qemu/${vmid}/config`, {
      method: "PUT",
      body: config,
    });
    return typeof result === "string" ? result : "";
  }

  async resizeDisk(node: string, vmid: number, disk: string, size: string): Promise<string> {
    const result = await this.request<string>(`/nodes/${node}/qemu/${vmid}/resize`, {
      method: "PUT",
      body: { disk, size },
    });
    return typeof result === "string" ? result : "";
  }

  async setCloudInitConfig(node: string, vmid: number, config: Record<string, unknown>): Promise<string> {
    return this.updateConfig(node, vmid, config);
  }

  async start(node: string, vmid: number): Promise<string> {
    const result = await this.request<string>(`/nodes/${node}/qemu/${vmid}/status/start`, {
      method: "POST",
      body: {},
    });
    return typeof result === "string" ? result : "";
  }

  async stop(node: string, vmid: number, timeoutSec = 30): Promise<string> {
    const result = await this.request<string>(`/nodes/${node}/qemu/${vmid}/status/stop`, {
      method: "POST",
      body: { timeout: timeoutSec },
    });
    return typeof result === "string" ? result : "";
  }

  async shutdown(node: string, vmid: number): Promise<string> {
    const result = await this.request<string>(`/nodes/${node}/qemu/${vmid}/status/shutdown`, {
      method: "POST",
      body: {},
    });
    return typeof result === "string" ? result : "";
  }

  async reboot(node: string, vmid: number): Promise<string> {
    const result = await this.request<string>(`/nodes/${node}/qemu/${vmid}/status/reboot`, {
      method: "POST",
      body: {},
    });
    return typeof result === "string" ? result : "";
  }

  async delete(node: string, vmid: number, purge = true): Promise<string> {
    const result = await this.request<string>(`/nodes/${node}/qemu/${vmid}?purge=${purge ? 1 : 0}`, {
      method: "DELETE",
    });
    return typeof result === "string" ? result : "";
  }

  async taskStatus(node: string, upid: string): Promise<ProxmoxTaskStatus> {
    const safe = encodeURIComponent(upid);
    return this.request<ProxmoxTaskStatus>(`/nodes/${node}/tasks/${safe}/status`);
  }

  async waitForTask(node: string, upid: string, timeoutMs = 600000, pollMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.taskStatus(node, upid);
      if (status.status === "stopped") {
        if (!status.exitstatus || status.exitstatus === "OK") return;
        throw new ProxmoxApiError(
          `Proxmox task ${upid} failed with exitstatus ${status.exitstatus}`,
          502,
          null,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new ProxmoxApiError(`Timed out waiting for Proxmox task ${upid}`, 504, null);
  }

  async agentInfo(node: string, vmid: number): Promise<Record<string, unknown> | null> {
    try {
      return await this.request<Record<string, unknown>>(`/nodes/${node}/qemu/${vmid}/agent/info`);
    } catch {
      return null;
    }
  }

  async agentOsInfo(node: string, vmid: number): Promise<{ id: string | null; name: string | null; prettyName: string | null } | null> {
    try {
      const result = await this.request<{ result?: Record<string, unknown> }>(`/nodes/${node}/qemu/${vmid}/agent/get-osinfo`);
      const r = result?.result ?? {};
      const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
      const pretty = pick(r["pretty-name"]) ?? pick(r.name) ?? pick(r.id);
      return { id: pick(r.id), name: pick(r.name), prettyName: pretty };
    } catch {
      return null;
    }
  }

  async agentNetworkInterfaces(node: string, vmid: number): Promise<Array<{ name: string; "ip-addresses": Array<{ "ip-address": string; "ip-address-type": string }> }>> {    const result = await this.request<{ result?: Array<Record<string, unknown>> }>(
      `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`,
    );
    const rows = (result?.result ?? []) as Array<{
      name: string;
      "ip-addresses"?: Array<{ "ip-address": string; "ip-address-type": string }>;
    }>;
    return rows.map((r) => ({
      name: String(r.name ?? ""),
      "ip-addresses": (r["ip-addresses"] ?? []).map((a) => ({
        "ip-address": String(a["ip-address"] ?? ""),
        "ip-address-type": String(a["ip-address-type"] ?? ""),
      })),
    }));
  }

  async agentExec(node: string, vmid: number, command: string, inputData?: string): Promise<number | null> {
    const result = await this.request<{ pid?: number }>(
      `/nodes/${node}/qemu/${vmid}/agent/exec`,
      { method: "POST", body: { command, "input-data": inputData } },
    );
    return result?.pid ?? null;
  }

  async agentExecStatus(node: string, vmid: number, pid: number): Promise<{ exited: boolean; outData: string; errData: string; exitCode: number | null }> {
    const result = await this.request<{
      exited: boolean;
      "out-data"?: string;
      "err-data"?: string;
      exitcode?: number;
    }>(`/nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`);
    return {
      exited: !!result.exited,
      outData: base64Decode(result["out-data"]),
      errData: base64Decode(result["err-data"]),
      exitCode: result.exitcode ?? null,
    };
  }

  async guestIpAddresses(node: string, vmid: number): Promise<ProxmoxAgentInfo | null> {
    const info = await this.agentInfo(node, vmid);
    if (!info) return null;
    const interfaces = await this.agentNetworkInterfaces(node, vmid);
    const ipv4s: string[] = [];
    const mapped = interfaces
      .map((iface) => {
        const addresses = iface["ip-addresses"]
          .filter((a) => a["ip-address-type"] === "ipv4")
          .map((a) => a["ip-address"]);
        for (const addr of addresses) ipv4s.push(addr);
        return { name: iface.name, addresses };
      })
      .filter((i) => i.addresses.length > 0);
    const result = (info as { result?: Record<string, unknown> }).result;
    return {
      reachable: true,
      osType:
        typeof result?.guest_os === "object" && result.guest_os !== null && typeof (result.guest_os as { name?: unknown }).name === "string"
          ? String((result.guest_os as { name: string }).name)
          : null,
      hostname:
        typeof result?.guest_os === "object" && result.guest_os !== null && typeof (result.guest_os as { hostname?: unknown }).hostname === "string"
          ? String((result.guest_os as { hostname: string }).hostname)
          : null,
      version: null,
      ipv4s: [...new Set(ipv4s)],
      interfaces: mapped,
    };
  }

  async waitForGuestAgent(node: string, vmid: number, timeoutMs = 600000, pollMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.agentInfo(node, vmid)) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  async startAgentExecAndWait(
    node: string,
    vmid: number,
    command: string,
    timeoutMs = 60000,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const pid = await this.agentExec(node, vmid, command);
    if (pid === null) {
      throw new ProxmoxApiError("Guest agent rejected the exec request", 502, null);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.agentExecStatus(node, vmid, pid);
      if (status.exited) {
        return { exitCode: status.exitCode, stdout: status.outData, stderr: status.errData };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new ProxmoxApiError(
      `Timed out waiting for guest command: ${command}`,
      504,
      null,
    );
  }
}

function base64Decode(value: string | undefined): string {
  if (!value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}