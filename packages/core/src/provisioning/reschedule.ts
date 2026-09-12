import type { AuditService } from "../services/audit.js";
import type { JobsRepository } from "../services/jobs.js";
import type { Logger } from "../util/logger.js";
import {
  MAX_WAIT_ATTEMPTS,
  WAIT_RECHECK_DELAY_MS,
  type RunOutcome,
} from "./pipeline.js";
import type { EnqueueJobData } from "../services/queue.js";

export interface RescheduleDeps {
  jobs: JobsRepository;
  audit: AuditService;
  logger: Logger;
}

export interface RescheduleQueue {
  add(name: string, data: EnqueueJobData, opts: { delay: number; jobId: string }): Promise<unknown>;
}

/**
 * Handles a provisioning attempt outcome on the worker side. Centralizes the
 * reschedule-limit check and the re-queue so a Redis/queue failure after an
 * attempt can never leave the DB job in a non-terminal state with no future
 * attempt queued: the job is compensated to FAILED (audited) and the error
 * is rethrown for BullMQ observability.
 */
export async function handleProvisioningOutcome(
  deps: RescheduleDeps,
  queue: RescheduleQueue,
  jobDbId: string,
  attempt: number,
  outcome: RunOutcome,
): Promise<RunOutcome> {
  if (outcome !== "RESCHEDULE") return outcome;
  if (attempt + 1 >= MAX_WAIT_ATTEMPTS) {
    deps.logger.error({ jobDbId }, "reschedule limit reached; marking failed");
    await deps.jobs.updateStatus(jobDbId, "FAILED", "Guest never became reachable within the allowed time");
    await deps.audit.record({
      event: "PROVISIONING_FAILED",
      jobId: jobDbId,
      detail: { reason: "reschedule limit reached", attempts: attempt + 1 },
    });
    return "FAILED";
  }
  try {
    await queue.add(
      "provision",
      { jobDbId, attempt: attempt + 1 },
      { delay: WAIT_RECHECK_DELAY_MS, jobId: `db-${jobDbId}-a${attempt + 1}` },
    );
    return "RESCHEDULE";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      deps.logger.error({ jobDbId, error: message }, "reschedule re-queue failed; marking job failed");
      await deps.jobs.updateStatus(jobDbId, "FAILED", `Failed to reschedule provisioning attempt: ${message}`);
      await deps.audit.record({
        event: "PROVISIONING_FAILED",
        jobId: jobDbId,
        detail: { reason: "reschedule-queue-failure", error: message, attempt },
      });
    } catch {
      // Compensation must never mask the original queue error.
    }
    throw err;
  }
}
