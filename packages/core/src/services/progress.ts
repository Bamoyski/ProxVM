// ---------------------------------------------------------------------------
// Job progress pub/sub: Redis channel per job feeding SSE subscribers.
// - Publishing is best-effort by design: a Redis blip must never fail a
//   healthy provisioning step or mask the real outcome, so failures are
//   swallowed and subscribers simply miss that update.
// - PROGRESS_COMPLETION maps lifecycle states to UI percentages; terminal
//   states all report 100 so the bar parks full on READY/FAILED/CANCELLED.
// - Channels are per-job (proxvm:job:<id>); step/job truth stays in the DB,
//   Redis carries hints only and is never read back as state.
// ---------------------------------------------------------------------------
import type IORedis from "ioredis";
import type { JobProgressData, JobStatus } from "@proxvm/shared";

/** Redis pub/sub channel carrying one job's progress events. */
export const jobProgressChannel = (jobId: string): string => `proxvm:job:${jobId}`;

export async function publishProgress(
  redis: IORedis,
  jobId: string,
  data: Omit<JobProgressData, "jobId" | "ts">,
): Promise<void> {
  // Best-effort telemetry: a Redis blip must never fail an otherwise healthy
  // provisioning step or mask the real outcome in runProvisioningJob.
  try {
    const payload: JobProgressData = {
      jobId,
      ...data,
      ts: new Date().toISOString(),
    };
    await redis.publish(jobProgressChannel(jobId), JSON.stringify(payload));
  } catch {
    // SSE subscribers simply miss this update; step/job state is unaffected.
  }
}

export const PROGRESS_COMPLETION: Record<string, number> = {
  PENDING: 0,
  CREATING: 5,
  PROVISIONING: 20,
  WAITING_FOR_GUEST: 55,
  CONFIGURING: 70,
  VERIFYING: 85,
  GUACAMOLE_CREATING: 95,
  READY: 100,
  FAILED: 100,
  CANCELLED: 100,
};

/** UI percentage for a lifecycle state; unknown states report 0. */
export function progressFor(status: JobStatus, step: string | null): number {
  return PROGRESS_COMPLETION[status] ?? 0;
}