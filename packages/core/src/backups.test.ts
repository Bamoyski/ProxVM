import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import {
  createCore,
  hashPassword,
  createBackupSchedule,
  createBackupRun,
  listBackupSchedules,
  listBackupRuns,
  deleteBackupSchedule,
  setBackupScheduleEnabled,
  runDueBackupSchedules,
  executePendingBackups,
  finalizeBackupRuns,
  listVmSnapshots,
  getBackupOverview,
  matchSnapshotsToVms,
  type CoreContext,
  type LocalConfig,
  type BackupTickerDeps,
} from "./index.js";

const masterKey = "a".repeat(64);

const localConfig: LocalConfig = {
  version: 1,
  app: {
    cookieSecure: false,
    sessionDurationHours: 12,
    sessionIdleTimeoutMinutes: 120,
    allowRegistrationOpen: false,
  },
  database: { host: "localhost", port: 5432, name: "proxvm", user: "u", password: "p", ssl: false },
  redis: { host: "127.0.0.1", port: 6379, db: 0 },
  secrets: {
    sessionSigningKey: "s".repeat(64),
    masterKeyId: "v1",
    masterKey,
  },
};

const silentLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never;

describe("PBS backup service", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;
  let creatorId: string;
  let vmId: string;
  const proxmoxCalls: string[] = [];
  let taskResult: { status: string; exitstatus: string | null } = { status: "stopped", exitstatus: "OK" };
  const fakeProxmox = {
    createBackup: async (node: string, opts: Record<string, unknown>) => {
      proxmoxCalls.push(`backup:${node}:${opts.vmid}:${opts.storage}:${opts.mode}`);
      return "UPID:backup:001";
    },
    taskStatus: async () => ({ ...taskResult }),
  };
  const pbsCalls: string[] = [];
  const fakePbs = {
    pruneSnapshots: async (datastore: string, opts: Record<string, unknown>) => {
      pbsCalls.push(`prune:${datastore}:${opts.backupId}:${opts.keepLast}`);
      return "UPID:prune:001";
    },
    pbsTaskStatus: async () => ({ status: "stopped", exitstatus: "OK" }),
    listBackupGroups: async () => [
      { "backup-id": "vm/9999", "backup-type": "vm", "backup-count": 2, "last-backup": 1700000000, files: [{ filename: "qemu-server.conf", password: "should-never-leak" }] },
      { "backup-id": "vm/1111", "backup-type": "vm", "backup-count": 1, "last-backup": 1700000000 },
    ],
  };

  function deps(): BackupTickerDeps {
    return {
      db: ctx.db,
      vms: ctx.vms,
      users: ctx.users,
      settings: ctx.settings,
      getProxmoxClient: async () => fakeProxmox as never,
      getPbsClient: async () => fakePbs as never,
      audit: ctx.audit,
      logger: silentLogger,
    };
  }

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMock() as never,
      logger: silentLogger,
    });
    cleanup = async () => {
      await pool.end().catch(() => undefined);
    };
    const creator = await ctx.users.create({
      username: "backup-op",
      passwordHash: await hashPassword("Backup-Op-1!"),
      roles: ["OPERATOR"],
    });
    creatorId = creator.id;
    const vm = await ctx.vms.create({ vmid: 991, node: "n1", name: "backup-vm" });
    vmId = vm.id;
    await ctx.settings.set("pbs.datastore", "pbs-data", { category: "infrastructure" });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("rejects invalid schedule input", async () => {
    const base = { vmId, storage: "pbs-store", minute: 0, hour: 2, createdBy: creatorId };
    await expect(createBackupSchedule(ctx.db, { ...base, mode: "full" })).rejects.toThrow(/mode must be/);
    await expect(createBackupSchedule(ctx.db, { ...base, storage: "bad storage!" })).rejects.toThrow(/storage must be/);
    await expect(createBackupSchedule(ctx.db, { ...base, minute: 60 })).rejects.toThrow(/minute must be/);
    await expect(createBackupSchedule(ctx.db, { ...base, hour: 24 })).rejects.toThrow(/hour must be/);
    await expect(createBackupSchedule(ctx.db, { ...base, days: "8" })).rejects.toThrow(/days must be/);
    await expect(createBackupSchedule(ctx.db, { ...base, keepLast: 0 })).rejects.toThrow(/keepLast must be/);
    await expect(createBackupSchedule(ctx.db, { ...base, keepLast: 366 })).rejects.toThrow(/keepLast must be/);
  });

  it("creates, lists, toggles, and deletes schedules", async () => {
    const s = await createBackupSchedule(ctx.db, {
      vmId, mode: "snapshot", storage: "pbs-store", minute: 30, hour: 3, keepLast: 7, createdBy: creatorId,
    });
    expect(s.mode).toBe("snapshot");
    expect(s.keepLast).toBe(7);
    expect(s.enabled).toBe(true);
    expect((await listBackupSchedules(ctx.db, vmId)).map((x) => x.id)).toContain(s.id);
    await setBackupScheduleEnabled(ctx.db, s.id, false);
    expect((await listBackupSchedules(ctx.db, vmId)).find((x) => x.id === s.id)?.enabled).toBe(false);
    expect(await deleteBackupSchedule(ctx.db, s.id)).toBe(true);
    expect(await deleteBackupSchedule(ctx.db, s.id)).toBe(false);
  });

  it("due schedules queue exactly one PENDING run (no pile-up)", async () => {
    const now = new Date();
    const s = await createBackupSchedule(ctx.db, {
      vmId, storage: "pbs-store", minute: now.getMinutes(), hour: now.getHours(), createdBy: creatorId,
    });
    const first = await runDueBackupSchedules(deps(), now);
    expect(first.queued).toBe(1);
    const second = await runDueBackupSchedules(deps(), now);
    expect(second.queued).toBe(0);
    const runs = await listBackupRuns(ctx.db, { vmId });
    expect(runs.filter((r) => r.scheduleId === s.id && r.status === "PENDING")).toHaveLength(1);
    // NOTE: deleting the schedule first NULLs run.schedule_id (ON DELETE
    // SET NULL keeps history), so capture run ids before deleting.
    const runIds = runs.filter((r) => r.scheduleId === s.id).map((r) => r.id);
    await deleteBackupSchedule(ctx.db, s.id);
    for (const runId of runIds) {
      await ctx.db.query("DELETE FROM pbs_backups WHERE id = $1", [runId]);
    }
  });

  it("skips schedules whose creator lost authorization (fail-closed)", async () => {
    const ex = await ctx.users.create({
      username: "ex-operator",
      passwordHash: await hashPassword("Ex-Operator-1!"),
      roles: ["OPERATOR"],
    });
    const now = new Date();
    const s = await createBackupSchedule(ctx.db, {
      vmId, storage: "pbs-store", minute: now.getMinutes(), hour: now.getHours(), createdBy: ex.id,
    });
    await ctx.users.setRoles(ex.id, ["USER"]);
    const result = await runDueBackupSchedules(deps(), now);
    expect(result.queued).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const audit = await ctx.audit.list({ vmId, limit: 20 });
    expect(audit.filter((a) => a.event === "BACKUP_SKIPPED").length).toBeGreaterThanOrEqual(1);
    await deleteBackupSchedule(ctx.db, s.id);
  });

  it("skips creator-less schedules", async () => {
    const now = new Date();
    const s = await createBackupSchedule(ctx.db, {
      vmId, storage: "pbs-store", minute: now.getMinutes(), hour: now.getHours(), createdBy: null,
    });
    const result = await runDueBackupSchedules(deps(), now);
    expect(result.queued).toBe(0);
    await deleteBackupSchedule(ctx.db, s.id);
  });

  it("executes pending runs and rejects revoked creators at execution", async () => {
    proxmoxCalls.length = 0;
    const run = await createBackupRun(ctx.db, {
      vmId, kind: "backup", mode: "snapshot", storage: "pbs-store", createdBy: creatorId,
    });
    const exec = await executePendingBackups(deps());
    expect(exec.started).toBe(1);
    expect(proxmoxCalls).toEqual(["backup:n1:991:pbs-store:snapshot"]);
    const reloaded = (await listBackupRuns(ctx.db, { vmId })).find((r) => r.id === run.id)!;
    expect(reloaded.status).toBe("RUNNING");
    expect(reloaded.upid).toBe("UPID:backup:001");

    // Revocation between queueing and execution fails the run, never Proxmox.
    const callsBefore = proxmoxCalls.length;
    const victim = await ctx.users.create({
      username: "revoked-runner",
      passwordHash: await hashPassword("Revoked-Run-1!"),
      roles: ["OPERATOR"],
    });
    const run2 = await createBackupRun(ctx.db, {
      vmId, kind: "backup", mode: "snapshot", storage: "pbs-store", createdBy: victim.id,
    });
    await ctx.users.setRoles(victim.id, ["USER"]);
    const exec2 = await executePendingBackups(deps());
    expect(exec2.failed).toBe(1);
    expect(proxmoxCalls.length).toBe(callsBefore);
    const failed = (await listBackupRuns(ctx.db, { vmId })).find((r) => r.id === run2.id)!;
    expect(failed.status).toBe("FAILED");
    await ctx.db.query("DELETE FROM pbs_backups WHERE id = $1 OR id = $2", [run.id, run2.id]);
  });

  it("finalizes successful runs and chains retention prunes", async () => {
    pbsCalls.length = 0;
    taskResult = { status: "stopped", exitstatus: "OK" };
    const run = await createBackupRun(ctx.db, {
      vmId, kind: "backup", mode: "snapshot", storage: "pbs-store", keepLast: 7, createdBy: creatorId,
    });
    await ctx.db.query("UPDATE pbs_backups SET status = 'RUNNING', upid = 'UPID:backup:001', started_at = NOW() WHERE id = $1", [run.id]);
    const fin = await finalizeBackupRuns(deps());
    expect(fin.finished).toBe(1);
    const done = (await listBackupRuns(ctx.db, { vmId })).find((r) => r.id === run.id)!;
    expect(done.status).toBe("OK");
    // keepLast chained exactly one prune run.
    const prunes = (await listBackupRuns(ctx.db, { vmId })).filter((r) => r.kind === "prune" && r.status === "PENDING");
    expect(prunes).toHaveLength(1);
    expect(prunes[0]!.keepLast).toBe(7);
    await ctx.db.query("DELETE FROM pbs_backups WHERE vm_id = $1", [vmId]);
  });

  it("notifies admins and the owner when a run fails", async () => {
    taskResult = { status: "stopped", exitstatus: "ERROR" };
    const run = await createBackupRun(ctx.db, {
      vmId, kind: "backup", mode: "snapshot", storage: "pbs-store", createdBy: creatorId,
    });
    await ctx.db.query("UPDATE pbs_backups SET status = 'RUNNING', upid = 'UPID:backup:bad', started_at = NOW() WHERE id = $1", [run.id]);
    await finalizeBackupRuns(deps());
    const notes = await ctx.db.query<{ audience: string; kind: string }>(
      "SELECT audience, kind FROM notifications WHERE title LIKE 'Backup % failed'",
    );
    const audiences = notes.rows.map((r) => r.audience).sort();
    expect(audiences).toEqual(["admins", creatorId].sort());
    expect(notes.rows.every((r) => r.kind === "backup")).toBe(true);
    taskResult = { status: "stopped", exitstatus: "OK" };
    await ctx.db.query("DELETE FROM pbs_backups WHERE vm_id = $1", [vmId]);
    await ctx.db.query("DELETE FROM notifications");
  });

  it("finalizes failed tasks and failed prunes honestly", async () => {
    taskResult = { status: "stopped", exitstatus: "ERROR" };
    const run = await createBackupRun(ctx.db, {
      vmId, kind: "backup", mode: "snapshot", storage: "pbs-store", createdBy: creatorId,
    });
    await ctx.db.query("UPDATE pbs_backups SET status = 'RUNNING', upid = 'UPID:backup:bad', started_at = NOW() WHERE id = $1", [run.id]);
    const fin = await finalizeBackupRuns(deps());
    expect(fin.failed).toBe(1);
    const done = (await listBackupRuns(ctx.db, { vmId })).find((r) => r.id === run.id)!;
    expect(done.status).toBe("FAILED");
    expect(done.error).toMatch(/ERROR/);
    taskResult = { status: "stopped", exitstatus: "OK" };
    await ctx.db.query("DELETE FROM pbs_backups WHERE vm_id = $1", [vmId]);
  });

  it("executes and finalizes prune runs against PBS", async () => {
    pbsCalls.length = 0;
    const run = await createBackupRun(ctx.db, {
      vmId, kind: "prune", keepLast: 5, createdBy: creatorId,
    });
    const exec = await executePendingBackups(deps());
    expect(exec.started).toBe(1);
    expect(pbsCalls).toEqual(["prune:pbs-data:vm/991:5"]);
    const fin = await finalizeBackupRuns(deps());
    expect(fin.finished).toBe(1);
    const audit = await ctx.audit.list({ vmId, limit: 20 });
    expect(audit.filter((a) => a.event === "BACKUP_PRUNED").length).toBeGreaterThanOrEqual(1);
    await ctx.db.query("DELETE FROM pbs_backups WHERE vm_id = $1", [vmId]);
  });

  it("refuses to pile up more than the per-VM cap", async () => {
    for (let i = 0; i < 3; i++) {
      await createBackupRun(ctx.db, { vmId, kind: "backup", storage: "pbs-store", createdBy: creatorId });
    }
    await expect(
      createBackupRun(ctx.db, { vmId, kind: "backup", storage: "pbs-store", createdBy: creatorId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await ctx.db.query("DELETE FROM pbs_backups WHERE vm_id = $1", [vmId]);
  });

  it("projects snapshots to safe scalars only", async () => {
    // Point the VM at vmid 9999 so the fixture group matches.
    await ctx.db.query("UPDATE vms SET vmid = 9999 WHERE id = $1", [vmId]);
    const snaps = await listVmSnapshots(deps(), vmId);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ backupId: "vm/9999", backupType: "vm", backupCount: 2 });
    expect(JSON.stringify(snaps)).not.toContain("should-never-leak");
    await ctx.db.query("UPDATE vms SET vmid = 991 WHERE id = $1", [vmId]);
  });

  it("matches snapshot groups to VMs without leaking group content", async () => {
    const vms = [
      { id: "vm-a", vmid: 10 },
      { id: "vm-b", vmid: 20 },
    ];
    const groups = [
      { "backup-id": "vm/10", "backup-type": "vm", "backup-count": 2, "last-backup": 1700000000, files: [{ secret: "x" }] },
      { "backup-id": "vm/30", "backup-type": "vm", "backup-count": 1, "last-backup": 1700000000 },
      "garbage",
      null,
      { "backup-type": "vm" },
    ];
    const matched = matchSnapshotsToVms(groups, vms);
    expect(matched.get("vm-a")).toMatchObject({ count: 2 });
    expect(matched.get("vm-a")?.lastBackup).toContain("2023");
    expect(matched.has("vm-b")).toBe(false);
    expect(JSON.stringify([...matched.entries()])).not.toContain("secret");
  });

  it("builds a fleet overview row per VM", async () => {
    const other = await ctx.vms.create({ vmid: 992, node: "n1", name: "overview-other" });
    await createBackupSchedule(ctx.db, {
      vmId, storage: "pbs-store", minute: 5, hour: 5, createdBy: creatorId,
    });
    const run = await createBackupRun(ctx.db, {
      vmId, kind: "backup", storage: "pbs-store", createdBy: creatorId,
    });
    await ctx.db.query("UPDATE pbs_backups SET status = 'OK', finished_at = NOW() WHERE id = $1", [run.id]);
    const overview = await getBackupOverview(
      { db: ctx.db, settings: ctx.settings, getPbsClient: async () => null },
      [
        { id: vmId, name: "backup-vm", vmid: 991, node: "n1" },
        { id: other.id, name: "overview-other", vmid: 992, node: "n1" },
      ],
    );
    const mine = overview.find((r) => r.vmId === vmId)!;
    expect(mine.schedules).toBe(1);
    expect(mine.enabledSchedules).toBe(1);
    expect(mine.lastRun).toMatchObject({ status: "OK", kind: "backup" });
    // PBS unavailable degrades to null snapshots, never throws.
    expect(mine.lastSnapshot).toBeNull();
    expect(overview.find((r) => r.vmId === other.id)).toMatchObject({ schedules: 0, lastRun: null });
    await ctx.db.query("DELETE FROM pbs_backup_schedules WHERE vm_id = $1 OR vm_id = $2", [vmId, other.id]);
    await ctx.db.query("DELETE FROM pbs_backups WHERE vm_id = $1", [vmId]);
    await ctx.db.query("DELETE FROM vms WHERE id = $1", [other.id]);
  });
});
