// ---------------------------------------------------------------------------
// Provisioning queue: BullMQ wrapper linking queue jobs to DB job rows.
// - Redis payloads are untrusted (shared bus): validateQueuePayload rejects
//   malformed/foreign shapes so the worker fails the DB row instead of
//   crashing on them; attempts stay single-shot (attempts: 1), retries are
//   explicit re-enqueues with bumped attempt counters.
// - Bull job ids embed the DB id + attempt (db-<id>-a<n>) for traceability;
//   the DB row stores the Bull id back so cancel paths can remove the right
//   queued job. removeBullJob is best-effort and never throws.
// ---------------------------------------------------------------------------
import type IORedis from "ioredis";
import { Queue } from "bullmq";
import { isUuid } from "../util/misc.js";
import type { JobsRepository } from "./jobs.js";

export const PROVISIONING_QUEUE = "proxvm-provisioning";

export interface EnqueueJobData {
  jobDbId: string;
  attempt: number;
}

/**
 * The queue is not a trust boundary (shared Redis): the worker validates
 * every payload with this before touching Proxmox. Returns null for anything
 * malformed so the worker can fail the DB row instead of crashing on it.
 */
export function validateQueuePayload(data: unknown): { jobDbId: string; attempt: number } | null {
  if (!data || typeof data !== "object") return null;
  const { jobDbId, attempt } = data as Partial<EnqueueJobData>;
  if (typeof jobDbId !== "string" || !isUuid(jobDbId)) return null;
  if (!Number.isInteger(attempt) || (attempt as number) < 0) return null;
  return { jobDbId, attempt: attempt as number };
}

/** Shared BullMQ queue with bounded retention for completed/failed jobs. */
export function createProvisioningQueue(redis: IORedis): Queue<EnqueueJobData> {
  return new Queue<EnqueueJobData>(PROVISIONING_QUEUE, {
    connection: redis,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
    },
  });
}

/**
 * Enqueues one provisioning attempt and links the Bull id back to the DB
 * row so cancel paths can remove the queued job. Delay defers the run.
 */
export async function enqueueProvisioningJob(
  queue: Queue<EnqueueJobData>,
  jobs: JobsRepository,
  jobDbId: string,
  opts: { delayMs?: number; attempt?: number } = {},
): Promise<void> {
  const bull = await queue.add(
    "provision",
    { jobDbId, attempt: opts.attempt ?? 0 },
    { delay: opts.delayMs ?? 0, jobId: `db-${jobDbId}-a${opts.attempt ?? 0}` },
  );
  await jobs.setBullJobId(jobDbId, bull.id ?? "");
}

export async function removeBullJob(queue: Queue<EnqueueJobData>, bullJobId: string | null): Promise<void> {
  if (!bullJobId) return;
  try {
    const job = await queue.getJob(bullJobId);
    if (job) await job.remove();
  } catch {
    return;
  }
}