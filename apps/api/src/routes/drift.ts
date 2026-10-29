// ---------------------------------------------------------------------------
// Drift routes: ground-truth reconciliation findings (services/drift.ts).
// Permission: drift.manage (deny-by-default; ADMIN holds it via the legacy
//   all-permissions path, custom roles must be granted it explicitly). Every
//   endpoint re-checks it via the preHandler — authorization is per-route,
//   never ambient.
// Destructive actions carry their OWN permission and confirmation: the
//   decommission remedy drops a VM record and its console connections, so it
//   needs vm.delete + guac.manage and a server-side typed confirmation —
//   exactly like DELETE /vms/:id, DELETE /templates/:id and the Guacamole
//   delete route. A confirmation that exists only in the browser is a UX
//   nicety, not a control.
// Audit: remediation/acknowledge writes THROUGH app.audit(request, ...):
//   actor/ip are filled from the session and redaction is audit-service
//   policy. Detection passes are logged, not audited (they change nothing).
// Privacy: findings carry no secrets, but they reference VM rows. List and
//   mutation both resolve each finding's VM through the same flag-aware
//   visibleTo gate as every VM route — a drift holder without the grant
//   never sees a privacy-flagged VM's findings, let alone remediates them.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AppError,
  closePowerPeriod,
  DRIFT_ENABLED_KEY,
  getDriftFinding,
  getDriftLastRun,
  listDriftFindings,
  runDriftPass,
  decommissionDriftVm,
  adoptDriftFinding,
  resyncDriftIp,
  deleteOrphanDriftConnection,
  acknowledgeDriftFinding,
  type CoreContext,
  type DriftActionDeps,
  type DriftPassDeps,
  type DriftPassResult,
} from "@proxvm/core";
import type { FastifyAuthRequest } from "../plugins/auth.js";

const FINDING_ID = z.guid();

const REMEDIATE_ACTIONS = ["adopt", "resync_ip", "decommission", "delete_orphan_connection"] as const;

export function buildDriftPassDeps(ctx: CoreContext): DriftPassDeps {
  return {
    db: ctx.db,
    settings: ctx.settings,
    vms: ctx.vms,
    jobs: ctx.jobs,
    guac: ctx.guac,
    creds: ctx.creds,
    hostKeys: ctx.hostKeys,
    decrypt: ctx.decrypt,
    getProxmoxClient: () => ctx.getProxmoxClient(),
    logger: ctx.logger,
  };
}

/**
 * ONE drift pass at a time, whoever asked for it.
 *
 * WHY the guard lives here and not in the ticker: `startHomelabTickers` kept
 * its own `driftInFlight` closure, which the manual endpoint could not
 * reach. A manual run could therefore stack with a ticker pass — both read
 * `last_probe_at` before either wrote it, so the 24h SSH-probe cooldown was
 * defeated and the admin alert fired twice. The guard must be reachable by
 * BOTH callers, so it lives in the module both of them import.
 *
 * Returns null when a pass is already running.
 */
let driftPassInFlight = false;

export async function runDriftPassExclusive(ctx: CoreContext): Promise<DriftPassResult | null> {
  if (driftPassInFlight) return null;
  driftPassInFlight = true;
  try {
    return await runDriftPass(buildDriftPassDeps(ctx));
  } finally {
    driftPassInFlight = false;
  }
}

export async function driftRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  /**
   * Request-scoped action dependencies: the audit writer goes THROUGH
   * app.audit(request, ...) so actor/ip can never silently log NULL.
   * Type note: the decorated app.audit isn't statically visible across
   * modules, hence the narrow local shape.
   */
  const actionDeps = (request: FastifyAuthRequest): DriftActionDeps => ({
    db: ctx.db,
    vms: ctx.vms,
    jobs: ctx.jobs,
    guac: ctx.guac,
    creds: ctx.creds,
    closePowerPeriod,
    hostKeys: ctx.hostKeys,
    audit: (entry) => app.audit(request, entry),
    decrypt: ctx.decrypt,
    getProxmoxClient: () => ctx.getProxmoxClient(),
    getGuacDb: () => ctx.getGuacDb(),
    logger: ctx.logger,
  });

  /**
   * Privacy gate for mutations: a finding whose VM is invisible to the
   * caller (privacy-flagged without a grant) is un-actionable and reads
   * as not-found — never as "exists but denied".
   */
  const assertFindingVisible = async (request: FastifyAuthRequest, findingId: string): Promise<void> => {
    const finding = await getDriftFinding(ctx.db, findingId);
    if (!finding) throw AppError.notFound("Drift finding not found");
    if (!finding.vmId) {
      // A finding with no VM target (an orphaned console record) is shown
      // on the board to privileged roles only; the mutation path must match
      // the board exactly, otherwise the unguarded path is the reachable one.
      const bearer = await app.requireAuth(request);
      if (!bearer.roles.includes("ADMIN") && !bearer.roles.includes("OPERATOR")) {
        throw AppError.notFound("Drift finding not found");
      }
      return;
    }
    const bearer = await app.requireAuth(request);
    const gate = await ctx.vms.visibleTo(bearer.id, bearer.roles, finding.vmId);
    if (!gate.allowed) throw AppError.notFound("Drift finding not found");
  };

  app.get(
    "/drift",
    { preHandler: app.requirePermission("drift.manage") },
    async (request: FastifyAuthRequest) => {
      const query = z
        .object({
          status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]).optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
        })
        .parse(request.query);

      const bearer = await app.requireAuth(request);
      const findings = await listDriftFindings(ctx.db, { status: query.status, limit: query.limit });
      const lastRun = await getDriftLastRun(ctx.settings);
      // Whether the feature is switched on at all. The board must be able
      // to say "nothing has been checked" - an empty board with no banner
      // reads as "no drift detected", which is exactly the wrong conclusion
      // when the pass never ran. A disabled feature is not persisted as a
      // skipped run, so this cannot be derived from `lastRun`.
      const enabled = (await ctx.settings.getPlain(DRIFT_ENABLED_KEY))?.trim().toLowerCase() === "true";

      // Per-request memo: visibleTo() is a findById plus up to two access
      // queries, and the board polls every 30s over up to 200 findings. The
      // naive loop was ~4 queries per finding (~800 per request) and
      // re-read the VM row a second time for the label.
      const vmCache = new Map<string, { allowed: boolean; vmName: string | null; vmid: number | null }>();
      const vmInfo = async (vmId: string): Promise<{ allowed: boolean; vmName: string | null; vmid: number | null }> => {
        const cached = vmCache.get(vmId);
        if (cached) return cached;
        const gate = await ctx.vms.visibleTo(bearer.id, bearer.roles, vmId);
        const vm = gate.allowed ? await ctx.vms.findById(vmId).catch(() => null) : null;
        const info = { allowed: gate.allowed, vmName: vm?.name ?? null, vmid: vm?.vmid ?? null };
        vmCache.set(vmId, info);
        return info;
      };

      // Flag-aware per-finding visibility (same gate as every VM route).
      // Vmless findings (decommissioned VMs / ghost guac records) resolve
      // their gate only for privileged roles: the referenced VM row either
      // no longer exists or was never visible, and there is nothing left
      // to grant access to.
      const privileged = bearer.roles.includes("ADMIN") || bearer.roles.includes("OPERATOR");
      const decorated = [];
      for (const finding of findings) {
        const row: (typeof finding) & { vmName?: string | null; vmid?: number | null } = { ...finding };
        if (finding.vmId) {
          const info = await vmInfo(finding.vmId);
          if (!info.allowed) continue;
          // Soft-deleted records keep their name/vmid on the finding row so
          // the UI can label the decommission confirm properly.
          row.vmName = info.vmName;
          row.vmid = info.vmid;
        } else if (!privileged) {
          continue;
        }
        decorated.push(row);
      }

      return { findings: decorated, lastRun, enabled, evaluatedAt: new Date().toISOString() };
    },
  );

  app.post(
    "/drift/run",
    {
      preHandler: app.requirePermission("drift.manage"),
      // A pass is expensive: one cluster listing, a config read per VM, a
      // guest-agent round trip per running VM and up to ten SSH probes.
      // The repo convention for expensive endpoints is an explicit limit
      // (discovery 10/hr, guacamole 10/hr, backups 5/hr); the global
      // 400/min was not enough.
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async () => {
      // Manual pass shares the exact orchestrator the ticker uses (same
      // exemptions, same fail-open) — no privileged "force" path: the
      // run cannot mutate anything beyond findings, so force is meaningless.
      const result = await runDriftPassExclusive(ctx);
      if (!result) throw AppError.conflict("A drift pass is already running");
      return result;
    },
  );

  app.post(
    "/drift/findings/:id/acknowledge",
    { preHandler: app.requirePermission("drift.manage") },
    async (request: FastifyAuthRequest) => {
      const bearer = await app.requireAuth(request);
      const { id } = z.object({ id: FINDING_ID }).parse(request.params);
      await assertFindingVisible(request, id);
      return await acknowledgeDriftFinding(
        actionDeps(request),
        id,
        { userId: bearer.id, username: bearer.username },
      );
    },
  );

  app.post(
    "/drift/findings/:id/remediate",
    { preHandler: app.requirePermission("drift.manage") },
    async (request: FastifyAuthRequest) => {
      const bearer = await app.requireAuth(request);
      const params = z.object({ id: FINDING_ID }).parse(request.params);
      const body = z
        .object({ action: z.enum(REMEDIATE_ACTIONS), confirmText: z.string().optional() })
        .parse(request.body ?? {});
      await assertFindingVisible(request, params.id);
      const deps = actionDeps(request);
      const actor = { userId: bearer.id, username: bearer.username };
      switch (body.action) {
        case "adopt":
          return await adoptDriftFinding(deps, params.id, actor);
        case "resync_ip":
          return await resyncDriftIp(deps, params.id, actor);
        case "decommission": {
          // The blast radius is a VM record PLUS its console connections, so
          // it needs the permissions of that blast radius — not "drift.manage",
          // which is a review permission.
          await app.requirePermission("vm.delete")(request);
          await app.requirePermission("guac.manage")(request);
          // Server-side typed confirmation, same shape as DELETE /vms/:id.
          // The browser's DECOMMISSION <name> prompt is a second line of
          // defence, not the control.
          const finding = await getDriftFinding(ctx.db, params.id);
          if (!finding?.vmId) throw AppError.notFound("Drift finding not found");
          const vm = await ctx.vms.requireById(finding.vmId);
          const expected = `DECOMMISSION ${vm.name}`;
          if (body.confirmText !== expected) {
            throw AppError.validation(`Confirmation text must be exactly: ${expected}`);
          }
          return await decommissionDriftVm(deps, params.id, actor);
        }
        case "delete_orphan_connection":
          return await deleteOrphanDriftConnection(deps, params.id, actor);
      }
    },
  );
}
