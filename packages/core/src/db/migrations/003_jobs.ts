export const jobsMigration = `
CREATE TABLE provisioning_jobs (
  id UUID PRIMARY KEY,
  vm_id UUID REFERENCES vms(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  error TEXT,
  request JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  bull_job_id TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_status ON provisioning_jobs(status);
CREATE INDEX idx_jobs_created ON provisioning_jobs(created_at DESC);

CREATE TABLE provisioning_steps (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES provisioning_jobs(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING',
  detail JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (job_id, step)
);

CREATE INDEX idx_steps_job ON provisioning_steps(job_id);
`;