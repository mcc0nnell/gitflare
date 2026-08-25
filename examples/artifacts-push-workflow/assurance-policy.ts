const GIT_OBJECT_ID = /^[a-f0-9]{40}([a-f0-9]{24})?$/i;

export const FIRECRAB_MINIMUM_POLICY = {
  schemaVersion: 1,
  id: 'gitflare/firecrab-release-minimum-v1',
  subjectProfile: 'firecrab-release-assurance-v1',
  preflight: {
    id: 'release-compliance-preflight',
    stage: 'release-compliance-preflight',
    runnerClass: 'sandbox',
    command: 'bash scripts/gitflare-release-compliance.sh',
    evidence: 'dist/gitflare-receipts/verdict.json',
  },
  m2images: [
    { alias: 'alpine', architecture: 'x86_64' },
    { alias: 'alpine', architecture: 'aarch64' },
    { alias: 'ubuntu', architecture: 'x86_64' },
    { alias: 'ubuntu', architecture: 'aarch64' },
    { alias: 'rocky', architecture: 'x86_64' },
    { alias: 'rocky', architecture: 'aarch64' },
  ],
  hosts: [
    { target: 'x86_64-unknown-linux-gnu', architecture: 'x86_64', libc: 'gnu', muslTools: false },
    { target: 'x86_64-unknown-linux-musl', architecture: 'x86_64', libc: 'musl', muslTools: true },
    { target: 'aarch64-unknown-linux-gnu', architecture: 'aarch64', libc: 'gnu', muslTools: false },
    { target: 'aarch64-unknown-linux-musl', architecture: 'aarch64', libc: 'musl', muslTools: true },
  ],
  aggregate: {
    id: 'aggregate',
    stage: 'aggregate',
    runnerClass: 'evidence',
    command:
      'python3 scripts/assemble_assurance.py --root dist/assurance --preflight dist/gitflare-receipts/verdict.json',
    evidence: 'dist/assurance/verdict.json',
  },
} as const;

type JsonRecord = Record<string, unknown>;

export interface AssuranceAdmission {
  plan: JsonRecord;
  planText: string;
  planDigest: string;
  policyId: typeof FIRECRAB_MINIMUM_POLICY.id;
  policyDigest: string;
  mandatoryJobIds: string[];
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function envMatches(job: JsonRecord, sha: string): void {
  const env = record(job.env, `job ${String(job.id)} env`);
  if (env.GITFLARE_EXPECTED_SHA !== sha) {
    throw new Error(`job ${String(job.id)} is not bound to the admitted Git object`);
  }
}

function requireExactJob(
  jobs: Map<string, JsonRecord>,
  expected: {
    id: string;
    stage: string;
    runnerClass: string;
    command: string;
    evidence: string;
  },
  sha: string,
): JsonRecord {
  const job = jobs.get(expected.id);
  if (!job) throw new Error(`assurance plan is missing mandatory job ${expected.id}`);
  for (const [key, value] of Object.entries(expected)) {
    if (job[key] !== value) {
      throw new Error(`mandatory job ${expected.id} has unexpected ${key}`);
    }
  }
  envMatches(job, sha);
  return job;
}

function requireConstraint(job: JsonRecord, name: string, expected: unknown): void {
  const constraints = record(job.constraints, `job ${String(job.id)} constraints`);
  if (constraints[name] !== expected) {
    throw new Error(`mandatory job ${String(job.id)} has unexpected constraint ${name}`);
  }
}

async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalPolicyText(): string {
  return JSON.stringify(FIRECRAB_MINIMUM_POLICY);
}

export async function admitFireCrabAssurancePlan(
  planText: string,
  expectedSha: string,
): Promise<AssuranceAdmission> {
  if (!GIT_OBJECT_ID.test(expectedSha)) throw new Error('invalid assurance subject Git object id');

  let parsed: unknown;
  try {
    parsed = JSON.parse(planText);
  } catch {
    throw new Error('assurance plan is invalid JSON');
  }
  const plan = record(parsed, 'assurance plan');
  if (
    plan.schemaVersion !== 1
    || plan.profile !== FIRECRAB_MINIMUM_POLICY.subjectProfile
    || plan.sha !== expectedSha
  ) {
    throw new Error('assurance plan subject/profile does not satisfy the external minimum policy');
  }

  if (!Array.isArray(plan.jobs) || plan.jobs.length === 0 || plan.jobCount !== plan.jobs.length) {
    throw new Error('assurance plan job coverage is invalid');
  }
  if (!Number.isSafeInteger(plan.nativeJobCount) || Number(plan.nativeJobCount) < 10) {
    throw new Error('assurance plan does not declare the minimum native proof count');
  }

  const jobs = new Map<string, JsonRecord>();
  for (const raw of plan.jobs) {
    const job = record(raw, 'assurance job');
    if (typeof job.id !== 'string' || job.id.length === 0) throw new Error('assurance job has invalid id');
    if (jobs.has(job.id)) throw new Error(`assurance plan contains duplicate job id ${job.id}`);
    jobs.set(job.id, job);
  }

  const mandatoryJobIds: string[] = [];
  const preflight = requireExactJob(jobs, FIRECRAB_MINIMUM_POLICY.preflight, expectedSha);
  mandatoryJobIds.push(FIRECRAB_MINIMUM_POLICY.preflight.id);
  if (stringArray(preflight.dependsOn, 'preflight dependsOn').length !== 0) {
    throw new Error('release compliance preflight may not depend on subject-selected work');
  }

  const nativeIds: string[] = [];
  for (const cell of FIRECRAB_MINIMUM_POLICY.m2images) {
    const id = `m2image-source:${cell.alias}:${cell.architecture}`;
    const job = requireExactJob(
      jobs,
      {
        id,
        stage: 'm2image-source-assurance',
        runnerClass: 'native-root',
        command: `bash scripts/gitflare-m2image-assurance.sh --alias ${cell.alias} --arch ${cell.architecture}`,
        evidence: `dist/assurance/m2images/${cell.alias}/${cell.architecture}/result.json`,
      },
      expectedSha,
    );
    requireConstraint(job, 'architecture', cell.architecture);
    requireConstraint(job, 'root', true);
    requireConstraint(job, 'network', true);
    requireConstraint(job, 'disposableWorkspace', true);
    if (!stringArray(job.dependsOn, `${id} dependsOn`).includes(FIRECRAB_MINIMUM_POLICY.preflight.id)) {
      throw new Error(`mandatory job ${id} must depend on release compliance preflight`);
    }
    nativeIds.push(id);
    mandatoryJobIds.push(id);
  }

  for (const cell of FIRECRAB_MINIMUM_POLICY.hosts) {
    const id = `host-release:${cell.target}`;
    const job = requireExactJob(
      jobs,
      {
        id,
        stage: 'host-release-assurance',
        runnerClass: 'native',
        command: `bash scripts/gitflare-host-assurance.sh --target ${cell.target}`,
        evidence: `dist/assurance/host/${cell.target}/result.json`,
      },
      expectedSha,
    );
    requireConstraint(job, 'architecture', cell.architecture);
    requireConstraint(job, 'libc', cell.libc);
    requireConstraint(job, 'muslTools', cell.muslTools);
    requireConstraint(job, 'network', true);
    requireConstraint(job, 'disposableWorkspace', true);
    if (!stringArray(job.dependsOn, `${id} dependsOn`).includes(FIRECRAB_MINIMUM_POLICY.preflight.id)) {
      throw new Error(`mandatory job ${id} must depend on release compliance preflight`);
    }
    nativeIds.push(id);
    mandatoryJobIds.push(id);
  }

  const aggregate = requireExactJob(jobs, FIRECRAB_MINIMUM_POLICY.aggregate, expectedSha);
  const aggregateDeps = new Set(stringArray(aggregate.dependsOn, 'aggregate dependsOn'));
  for (const id of nativeIds) {
    if (!aggregateDeps.has(id)) throw new Error(`aggregate is not bound to mandatory proof ${id}`);
  }
  mandatoryJobIds.push(FIRECRAB_MINIMUM_POLICY.aggregate.id);

  const [planDigest, policyDigest] = await Promise.all([
    sha256Text(planText),
    sha256Text(canonicalPolicyText()),
  ]);
  return {
    plan,
    planText,
    planDigest: `sha256:${planDigest}`,
    policyId: FIRECRAB_MINIMUM_POLICY.id,
    policyDigest: `sha256:${policyDigest}`,
    mandatoryJobIds,
  };
}
