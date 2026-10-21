// ---------------------------------------------------------------------------
// Drift routes: ground-truth reconciliation findings (services/drift.ts).
// Permission: drift.manage (deny-by-default; ADMIN holds it via the legacy
//   all-permissions path, custom roles must be granted it explicitly). Every
//   endpoint re-checks it via the preHandler — authorization is per-route,
//   never ambient.
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
} from "@proxvm/core";
import type { FastifyAuthRequest } from "../plugins/auth.js";

const FINDING_ID = z.string().uuid();

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
    if (!finding.vmId) return;
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
          const gate = await ctx.vms.visibleTo(bearer.id, bearer.roles, finding.vmId);
          if (!gate.allowed) continue;
          const vm = await ctx.vms.findById(finding.vmId).catch(() => null);
          // Soft-deleted records keep their name/vmid on the finding row so
          // the UI can label the decommission confirm properly.
          if (vm) {
            row.vmName = vm.name;
            row.vmid = vm.vmid;
          }
        } else if (!privileged) {
          continue;
        }
        decorated.push(row);
      }

      return { findings: decorated, lastRun, evaluatedAt: new Date().toISOString() };
    },
  );

  app.post(
    "/drift/run",
    { preHandler: app.requirePermission("drift.manage") },
    async () => {
      // Manual pass shares the exact orchestrator the ticker uses (same
      // exemptions, same fail-open) — no privileged "force" path: the
      // run cannot mutate anything beyond findings, so force is meaningless.
      return await runDriftPass(buildDriftPassDeps(ctx));
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
        .object({ action: z.enum(REMEDIATE_ACTIONS) })
        .parse(request.body ?? {});
      await assertFindingVisible(request, params.id);
      const deps = actionDeps(request);
      const actor = { userId: bearer.id, username: bearer.username };
      switch (body.action) {
        case "adopt":
          return await adoptDriftFinding(deps, params.id, actor);
        case "resync_ip":
          return await resyncDriftIp(deps, params.id, actor);
        case "decommission":
          return await decommissionDriftVm(deps, params.id, actor);
        case "delete_orphan_connection":
          return await deleteOrphanDriftConnection(deps, params.id, actor);
      }
    },
  );
}
