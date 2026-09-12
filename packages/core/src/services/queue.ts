import type IORedis from "ioredis";
import { Queue } from "bullmq";
import type { JobsRepository } from "./jobs.js";

export const PROVISIONING_QUEUE = "proxvm-provisioning";

export interface EnqueueJobData {
  jobDbId: string;
  attempt: number;
}

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