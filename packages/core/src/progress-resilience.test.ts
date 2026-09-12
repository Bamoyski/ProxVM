import { describe, expect, it } from "vitest";
import { jobProgressChannel, publishProgress } from "./index.js";

describe("progress publication resilience", () => {
  it("never throws when Redis publish fails", async () => {
    const deadRedis = {
      publish: async (): Promise<never> => {
        throw new Error("Redis connection lost");
      },
    } as never;
    await expect(
      publishProgress(deadRedis, "job-1", {
        vmId: null,
        status: "PROVISIONING",
        step: null,
        error: null,
        progress: 20,
        message: "Running CONFIGURE_VM",
      }),
    ).resolves.toBeUndefined();
  });

  it("publishes to the per-job channel when Redis is healthy", async () => {
    const published: Array<{ channel: string; payload: string }> = [];
    const redis = {
      publish: async (channel: string, payload: string) => {
        published.push({ channel, payload });
        return 1;
      },
    } as never;
    await publishProgress(redis, "job-2", {
      vmId: null,
      status: "READY",
      step: null,
      error: null,
      progress: 100,
      message: "VM is ready",
    });
    expect(published).toHaveLength(1);
    expect(published[0]!.channel).toBe(jobProgressChannel("job-2"));
    expect(JSON.parse(published[0]!.payload)).toMatchObject({ jobId: "job-2", status: "READY" });
  });
});
