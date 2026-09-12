import type { Pool } from "pg";
import type { JobStatus, JobStep, ProvisioningStepRecord, StepState } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import { isUuid, newId } from "../util/misc.js";
import type { JobRow, StepRow } from "./rows.js";

export interface JobRecord {
  id: string;
  vmId: string | null;
  status: JobStatus;
  error: string | null;
  request: Record<string, unknown>;
  createdByUserId: string | null;
  bullJobId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class JobsRepository {
  constructor(private readonly db: Pool) {}

  async create(opts: {
    vmId: string | null;
    request: Record<string, unknown>;
    createdByUserId: string | null;
    bullJobId?: string | null;
  }): Promise<JobRecord> {
    const result = await this.db.query<JobRow>(
      `INSERT INTO provisioning_jobs (id, vm_id, status, request, created_by_user_id, bull_job_id)
       VALUES ($1, $2, 'PENDING', $3, $4, $5)
       RETURNING *`,
      [newId(), opts.vmId, JSON.stringify(opts.request), opts.createdByUserId, opts.bullJobId ?? null],
    );
    return toJobRecord(result.rows[0] as JobRow);
  }

  async get(id: string): Promise<JobRecord | null> {
    if (!isUuid(id)) return null;
    const result = await this.db.query<JobRow>(
      "SELECT * FROM provisioning_jobs WHERE id = $1",
      [id],
    );
    return result.rows[0] ? toJobRecord(result.rows[0]) : null;
  }

  async require(id: string): Promise<JobRecord> {
    const job = await this.get(id);
    if (!job) throw AppError.notFound("Provisioning job not found");
    return job;
  }

  async list(opts: { limit?: number; offset?: number; status?: JobStatus; vmId?: string }): Promise<JobRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      params.push(opts.status);
      conditions.push(`status = $${params.length}`);
    }
    if (opts.vmId) {
      params.push(opts.vmId);
      conditions.push(`vm_id = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts.limit ?? 50, opts.offset ?? 0);
    const result = await this.db.query<JobRow>(
      `SELECT * FROM provisioning_jobs ${where}
       ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows.map(toJobRecord);
  }

  async updateStatus(id: string, status: JobStatus, error: string | null = null): Promise<void> {
    await this.db.query(
      `UPDATE provisioning_jobs
       SET status = $2, error = $3,
           started_at = CASE WHEN started_at IS NULL AND $2 <> 'PENDING' THEN NOW() ELSE started_at END,
           finished_at = CASE WHEN $2 IN ('READY','FAILED','CANCELLED') THEN NOW() ELSE finished_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [id, status, error],
    );
  }

  async setBullJobId(id: string, bullJobId: string): Promise<void> {
    await this.db.query("UPDATE provisioning_jobs SET bull_job_id = $2, updated_at = NOW() WHERE id = $1", [
      id,
      bullJobId,
    ]);
  }

  async setVmId(id: string, vmId: string): Promise<void> {
    await this.db.query("UPDATE provisioning_jobs SET vm_id = $2, updated_at = NOW() WHERE id = $1", [
      id,
      vmId,
    ]);
  }

  async resetForRetry(id: string): Promise<void> {
    await this.db.query(
      `UPDATE provisioning_jobs SET status = 'PENDING', error = NULL, updated_at = NOW() WHERE id = $1`,
      [id],
    );
    await this.db.query(
      `UPDATE provisioning_steps SET state = 'PENDING', error = NULL, finished_at = NULL
       WHERE job_id = $1 AND state IN ('FAILED')`,
      [id],
    );
  }

  async setStep(jobId: string, step: JobStep, state: StepState, detail: Record<string, unknown> | null = null, error: string | null = null): Promise<void> {
    await this.db.query(
      `INSERT INTO provisioning_steps (id, job_id, step, state, detail, error, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6,
         CASE WHEN $4 = 'RUNNING' THEN NOW() ELSE NULL END,
         CASE WHEN $4 IN ('SUCCEEDED','FAILED','SKIPPED') THEN NOW() ELSE NULL END)
       ON CONFLICT (job_id, step) DO UPDATE SET
         state = EXCLUDED.state,
         detail = EXCLUDED.detail,
         error = EXCLUDED.error,
         started_at = CASE WHEN EXCLUDED.state = 'RUNNING' THEN COALESCE(provisioning_steps.started_at, NOW()) ELSE provisioning_steps.started_at END,
         finished_at = CASE WHEN EXCLUDED.state IN ('SUCCEEDED','FAILED','SKIPPED') THEN NOW() ELSE provisioning_steps.finished_at END`,
      [newId(), jobId, step, state, detail ? JSON.stringify(detail) : null, error],
    );
  }

  async getSteps(jobId: string): Promise<ProvisioningStepRecord[]> {
    const result = await this.db.query<StepRow>(
      `SELECT * FROM provisioning_steps WHERE job_id = $1 ORDER BY started_at ASC, id ASC`,
      [jobId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      step: r.step,
      state: r.state,
      detail: typeof r.detail === "object" && r.detail !== null ? (r.detail as Record<string, unknown>) : null,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  }

  async completedSteps(jobId: string): Promise<Set<JobStep>> {
    const steps = await this.getSteps(jobId);
    return new Set(steps.filter((s) => s.state === "SUCCEEDED" || s.state === "SKIPPED").map((s) => s.step));
  }

  async cancel(id: string): Promise<void> {
    await this.db.query(
      "UPDATE provisioning_jobs SET status = 'CANCELLED', finished_at = NOW(), updated_at = NOW() WHERE id = $1",
      [id],
    );
  }

  /** An active (non-terminal) job by the same creator for the same VM name,
   *  if any. Used to reject accidental duplicate submissions (e.g. double
   *  form submit) that would otherwise provision two identical VMs. */
  async activeJobWithName(createdByUserId: string, name: string): Promise<JobRecord | null> {
    const result = await this.db.query<JobRow>(
      `SELECT * FROM provisioning_jobs
        WHERE created_by_user_id = $1
          AND status <> 'READY' AND status <> 'FAILED' AND status <> 'CANCELLED'
          AND request->>'name' = $2
        ORDER BY created_at DESC LIMIT 1`,
      [createdByUserId, name],
    );
    return result.rows[0] ? toJobRecord(result.rows[0]) : null;
  }

  async activeJobsForVm(vmId: string): Promise<JobRecord[]> {
    const result = await this.db.query<JobRow>(
      `SELECT * FROM provisioning_jobs
       WHERE vm_id = $1 AND status NOT IN ('READY','FAILED','CANCELLED')`,
      [vmId],
    );
    return result.rows.map(toJobRecord);
  }
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    vmId: row.vm_id,
    status: row.status,
    error: row.error,
    request: typeof row.request === "object" && row.request !== null ? (row.request as Record<string, unknown>) : {},
    createdByUserId: row.created_by_user_id,
    bullJobId: row.bull_job_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}