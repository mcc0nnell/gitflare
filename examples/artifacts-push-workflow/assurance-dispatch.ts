import {
  FIRECRAB_MINIMUM_POLICY,
  type AssuranceAdmission,
} from './assurance-policy';

type JsonRecord = Record<string, unknown>;
export type NativeArchitecture = 'x86_64' | 'aarch64';

const APPROVAL_ID = /^approval:[0-9a-f-]{36}$/i;
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const REPO = /^[A-Za-z0-9._-]{1,96}$/;
const SHELL_ORIGIN = 'https://scumm-shell.internal';

export interface ShellService {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface AssuranceSourceIdentity {
  provider: 'cloudflare-artifacts';
  namespace: 'gitflare';
  repo: string;
  sha: string;
  ref: string;
}

export interface NativeDispatchJob {
  jobId: string;
  label: string;
  architecture: NativeArchitecture;
  argv: string[];
  requirements: {
    isolation: 'virtual-machine';
    persistence: 'ephemeral';
    network: 'egress';
    architecture: NativeArchitecture;
    kernelControl: boolean;
    kvm: false;
    offline: false;
  };
  source: AssuranceSourceIdentity;
  evidence: string;
}

export interface DispatchedNativeJob {
  jobId: string;
  architecture: NativeArchitecture;
  buildId: string;
  workspaceId: string;
  evidence: string;
  source: AssuranceSourceIdentity;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function sourceIdentity(value: AssuranceSourceIdentity): AssuranceSourceIdentity {
  if (value.provider !== 'cloudflare-artifacts' || value.namespace !== 'gitflare') {
    throw new Error('assurance source must be cloudflare-artifacts/gitflare');
  }
  if (!REPO.test(value.repo)) throw new Error('assurance source repo is invalid');
  if (!GIT_OBJECT_ID.test(value.sha)) throw new Error('assurance source sha is invalid');
  if (
    !(value.ref.startsWith('refs/heads/') || value.ref.startsWith('refs/tags/'))
    || /[\u0000-\u001f\u007f]/.test(value.ref)
  ) {
    throw new Error('assurance source ref is invalid');
  }
  return { ...value, sha: value.sha.toLowerCase() };
}

export function assuranceWorkspaceId(repo: string, sha: string): string {
  if (!REPO.test(repo)) throw new Error('assurance workspace repo is invalid');
  if (!GIT_OBJECT_ID.test(sha)) throw new Error('assurance workspace sha is invalid');
  return `gitflare-assurance-${repo.toLowerCase()}-${sha.toLowerCase().slice(0, 32)}`;
}

function planJobs(admission: AssuranceAdmission): Map<string, JsonRecord> {
  const plan = record(admission.plan, 'assurance plan');
  if (plan.sha !== admission.plan.sha || !Array.isArray(plan.jobs)) {
    throw new Error('assurance admission does not contain a valid plan');
  }
  const jobs = new Map<string, JsonRecord>();
  for (const raw of plan.jobs) {
    const job = record(raw, 'assurance job');
    if (typeof job.id !== 'string' || jobs.has(job.id)) {
      throw new Error('assurance admission contains an invalid or duplicate job id');
    }
    jobs.set(job.id, job);
  }
  return jobs;
}

function requireAdmittedJob(
  admission: AssuranceAdmission,
  jobs: Map<string, JsonRecord>,
  id: string,
  architecture: NativeArchitecture,
  expectedCommand: string,
  expectedEvidence: string,
): JsonRecord {
  if (!admission.mandatoryJobIds.includes(id)) {
    throw new Error(`native assurance job ${id} is not in the admitted mandatory set`);
  }
  const job = jobs.get(id);
  if (!job) throw new Error(`admitted native assurance job is missing: ${id}`);
  if (job.command !== expectedCommand || job.evidence !== expectedEvidence) {
    throw new Error(`admitted native assurance job changed command/evidence: ${id}`);
  }
  const constraints = record(job.constraints, `job ${id} constraints`);
  if (constraints.architecture !== architecture) {
    throw new Error(`admitted native assurance job changed architecture: ${id}`);
  }
  return job;
}

/**
 * Translate only the externally-mandated native cells into TalkPipe semantic
 * execution envelopes. We intentionally do not shell-parse subject-authored
 * command strings: argv is reconstructed from the external policy itself.
 */
export function nativeDispatchJobs(
  admission: AssuranceAdmission,
  rawSource: AssuranceSourceIdentity,
): NativeDispatchJob[] {
  const source = sourceIdentity(rawSource);
  const plan = record(admission.plan, 'assurance plan');
  if (plan.sha !== source.sha) throw new Error('assurance plan/source sha mismatch');
  const jobs = planJobs(admission);
  const result: NativeDispatchJob[] = [];

  for (const cell of FIRECRAB_MINIMUM_POLICY.m2images) {
    const id = `m2image-source:${cell.alias}:${cell.architecture}`;
    const command = `bash scripts/gitflare-m2image-assurance.sh --alias ${cell.alias} --arch ${cell.architecture}`;
    const evidence = `dist/assurance/m2images/${cell.alias}/${cell.architecture}/result.json`;
    requireAdmittedJob(admission, jobs, id, cell.architecture, command, evidence);
    result.push({
      jobId: id,
      label: id,
      architecture: cell.architecture,
      argv: ['bash', 'scripts/gitflare-m2image-assurance.sh', '--alias', cell.alias, '--arch', cell.architecture],
      requirements: {
        isolation: 'virtual-machine',
        persistence: 'ephemeral',
        network: 'egress',
        architecture: cell.architecture,
        kernelControl: true,
        kvm: false,
        offline: false,
      },
      source,
      evidence,
    });
  }

  for (const cell of FIRECRAB_MINIMUM_POLICY.hosts) {
    const id = `host-release:${cell.target}`;
    const command = `bash scripts/gitflare-host-assurance.sh --target ${cell.target}`;
    const evidence = `dist/assurance/host/${cell.target}/result.json`;
    requireAdmittedJob(admission, jobs, id, cell.architecture, command, evidence);
    result.push({
      jobId: id,
      label: id,
      architecture: cell.architecture,
      argv: ['bash', 'scripts/gitflare-host-assurance.sh', '--target', cell.target],
      requirements: {
        isolation: 'virtual-machine',
        persistence: 'ephemeral',
        network: 'egress',
        architecture: cell.architecture,
        kernelControl: false,
        kvm: false,
        offline: false,
      },
      source,
      evidence,
    });
  }

  if (result.length !== 10) throw new Error('external minimum policy did not expand to ten native jobs');
  return result;
}

async function shellJson(
  shell: ShellService,
  path: string,
  init: RequestInit,
): Promise<JsonRecord> {
  const response = await shell.fetch(new Request(`${SHELL_ORIGIN}${path}`, init));
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`SCUMM Shell returned invalid JSON for ${path}`);
  }
  const body = record(value, 'SCUMM Shell response');
  if (!response.ok) {
    const detail = typeof body.error === 'string' ? body.error.slice(0, 500) : `HTTP ${response.status}`;
    throw new Error(`SCUMM Shell rejected ${path}: ${detail}`);
  }
  return body;
}

async function issueBuildApproval(
  shell: ShellService,
  workspaceId: string,
  source: AssuranceSourceIdentity,
  jobId: string,
): Promise<string> {
  const body = await shellJson(shell, '/internal/v1/approvals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId,
      capability: 'shell.build.trigger',
      issuer: 'gitflare-assurance',
      subject: `${source.repo}@${source.sha}:${jobId}`,
      ttlSeconds: 300,
    }),
  });
  const id = body.id;
  if (
    typeof id !== 'string'
    || !APPROVAL_ID.test(id)
    || body.workspaceId !== workspaceId
    || body.capability !== 'shell.build.trigger'
  ) {
    throw new Error(`SCUMM Shell returned an invalid one-use build approval for ${jobId}`);
  }
  return id;
}

export async function dispatchNativeJob(
  shell: ShellService,
  workspaceId: string,
  job: NativeDispatchJob,
): Promise<DispatchedNativeJob> {
  const approvalId = await issueBuildApproval(shell, workspaceId, job.source, job.jobId);
  const body = await shellJson(
    shell,
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/assurance-builds`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-scumm-shell-admission': 'approved',
        'x-scumm-shell-approval-id': approvalId,
      },
      body: JSON.stringify({
        label: job.label,
        argv: job.argv,
        requirements: job.requirements,
        source: job.source,
      }),
    },
  );

  if (body.architecture !== job.architecture) {
    throw new Error(`SCUMM Shell changed architecture for ${job.jobId}`);
  }
  const source = record(body.source, `SCUMM Shell trigger source for ${job.jobId}`);
  for (const [key, value] of Object.entries(job.source)) {
    if (source[key] !== value) throw new Error(`SCUMM Shell changed source ${key} for ${job.jobId}`);
  }
  const buildId = body.buildId;
  if (typeof buildId !== 'string' || !BUILD_ID.test(buildId)) {
    throw new Error(`SCUMM Shell returned an invalid build id for ${job.jobId}`);
  }
  return {
    jobId: job.jobId,
    architecture: job.architecture,
    buildId: buildId.toLowerCase(),
    workspaceId,
    evidence: job.evidence,
    source: job.source,
  };
}

export async function readNativeJobStatus(
  shell: ShellService,
  job: DispatchedNativeJob,
): Promise<JsonRecord> {
  const body = await shellJson(
    shell,
    `/v1/workspaces/${encodeURIComponent(job.workspaceId)}/assurance-builds/${job.architecture}/${job.buildId}`,
    { method: 'GET' },
  );
  if (body.architecture !== job.architecture || body.buildId !== job.buildId) {
    throw new Error(`SCUMM Shell returned mismatched status identity for ${job.jobId}`);
  }
  return body;
}

export async function readNativeJobLog(
  shell: ShellService,
  job: DispatchedNativeJob,
): Promise<JsonRecord> {
  const body = await shellJson(
    shell,
    `/v1/workspaces/${encodeURIComponent(job.workspaceId)}/assurance-builds/${job.architecture}/${job.buildId}/log`,
    { method: 'GET' },
  );
  if (body.architecture !== job.architecture || body.buildId !== job.buildId) {
    throw new Error(`SCUMM Shell returned mismatched log identity for ${job.jobId}`);
  }
  return body;
}

export function nativeStatusTerminal(status: JsonRecord): boolean {
  return status.complete === true || ['completed', 'error', 'cancelled'].includes(String(status.phase ?? ''));
}

export function nativeStatusSucceeded(status: JsonRecord): boolean {
  return nativeStatusTerminal(status) && status.conclusion === 'success' && status.exitCode === 0;
}
