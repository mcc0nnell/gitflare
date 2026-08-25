import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assuranceWorkspaceId,
  dispatchNativeJob,
  extractNativeEvidence,
  nativeDispatchJobs,
  readNativeJobLog,
  readNativeJobStatus,
  type AssuranceSourceIdentity,
  type DispatchedNativeJob,
  type NativeDispatchJob,
  type ShellService,
} from './assurance-dispatch';
import {
  admitFireCrabAssurancePlan,
  FIRECRAB_MINIMUM_POLICY,
} from './assurance-policy';

const SHA = 'a'.repeat(40);
const SOURCE: AssuranceSourceIdentity = {
  provider: 'cloudflare-artifacts',
  namespace: 'gitflare',
  repo: 'firecrab',
  sha: SHA,
  ref: 'refs/heads/assurance',
};

function planText(): string {
  const jobs: Record<string, unknown>[] = [
    {
      ...FIRECRAB_MINIMUM_POLICY.preflight,
      env: { GITFLARE_EXPECTED_SHA: SHA },
      dependsOn: [],
    },
  ];
  const nativeIds: string[] = [];
  for (const cell of FIRECRAB_MINIMUM_POLICY.m2images) {
    const id = `m2image-source:${cell.alias}:${cell.architecture}`;
    nativeIds.push(id);
    jobs.push({
      id,
      stage: 'm2image-source-assurance',
      runnerClass: 'native-root',
      constraints: {
        architecture: cell.architecture,
        root: true,
        network: true,
        disposableWorkspace: true,
      },
      command: `bash scripts/gitflare-m2image-assurance.sh --alias ${cell.alias} --arch ${cell.architecture}`,
      env: { GITFLARE_EXPECTED_SHA: SHA },
      evidence: `dist/assurance/m2images/${cell.alias}/${cell.architecture}/result.json`,
      dependsOn: [FIRECRAB_MINIMUM_POLICY.preflight.id],
    });
  }
  for (const cell of FIRECRAB_MINIMUM_POLICY.hosts) {
    const id = `host-release:${cell.target}`;
    nativeIds.push(id);
    jobs.push({
      id,
      stage: 'host-release-assurance',
      runnerClass: 'native',
      constraints: {
        architecture: cell.architecture,
        libc: cell.libc,
        muslTools: cell.muslTools,
        network: true,
        disposableWorkspace: true,
      },
      command: `bash scripts/gitflare-host-assurance.sh --target ${cell.target}`,
      env: { GITFLARE_EXPECTED_SHA: SHA },
      evidence: `dist/assurance/host/${cell.target}/result.json`,
      dependsOn: [FIRECRAB_MINIMUM_POLICY.preflight.id],
    });
  }
  jobs.push({
    ...FIRECRAB_MINIMUM_POLICY.aggregate,
    env: { GITFLARE_EXPECTED_SHA: SHA },
    dependsOn: nativeIds,
  });
  return JSON.stringify({
    schemaVersion: 1,
    profile: FIRECRAB_MINIMUM_POLICY.subjectProfile,
    sha: SHA,
    jobCount: jobs.length,
    nativeJobCount: nativeIds.length,
    jobs,
  });
}

function evidencePayload(job: NativeDispatchJob): Record<string, unknown> {
  if (job.jobId.startsWith('m2image-source:')) {
    const [, alias] = job.jobId.split(':');
    return {
      schemaVersion: 1,
      profile: 'firecrab-release-assurance-v1',
      stage: 'm2image-source-assurance',
      subject: { sha: SHA, alias, architecture: job.architecture },
      verdict: 'PASS',
      reason: 'ok',
    };
  }
  const target = job.jobId.slice('host-release:'.length);
  return {
    schemaVersion: 1,
    profile: 'firecrab-release-assurance-v1',
    stage: 'host-release-assurance',
    subject: { sha: SHA, target, architecture: job.architecture },
    verdict: 'PASS',
    reason: 'ok',
  };
}

function dispatched(job: NativeDispatchJob): DispatchedNativeJob {
  return {
    jobId: job.jobId,
    requestId: '123e4567-e89b-42d3-a456-426614174001',
    architecture: job.architecture,
    buildId: '123e4567-e89b-42d3-a456-426614174000',
    workspaceId: assuranceWorkspaceId('firecrab', SHA),
    evidence: job.evidence,
    source: job.source,
  };
}

test('dispatcher expands only ten externally admitted native cells', async () => {
  const admission = await admitFireCrabAssurancePlan(planText(), SHA);
  const jobs = nativeDispatchJobs(admission, SOURCE);
  assert.equal(jobs.length, 10);
  assert.equal(jobs.filter((job) => job.architecture === 'x86_64').length, 5);
  assert.equal(jobs.filter((job) => job.architecture === 'aarch64').length, 5);
  assert.equal(jobs.filter((job) => job.requirements.kernelControl).length, 6);
  assert.ok(jobs.every((job) => job.requirements.isolation === 'virtual-machine'));
  assert.ok(jobs.every((job) => job.requirements.persistence === 'ephemeral'));
  assert.ok(jobs.every((job) => job.source.sha === SHA));
});

test('dispatcher reconstructs argv instead of shell-parsing subject command text', async () => {
  const admission = await admitFireCrabAssurancePlan(planText(), SHA);
  const jobs = nativeDispatchJobs(admission, SOURCE);
  const rockyArm = jobs.find((job) => job.jobId === 'm2image-source:rocky:aarch64');
  assert.deepEqual(rockyArm?.argv, [
    'bash',
    'scripts/gitflare-m2image-assurance.sh',
    '--alias',
    'rocky',
    '--arch',
    'aarch64',
  ]);
});

test('dispatcher fails closed if mandatory admission is removed after policy check', async () => {
  const admission = await admitFireCrabAssurancePlan(planText(), SHA);
  const weakened = {
    ...admission,
    mandatoryJobIds: admission.mandatoryJobIds.filter((id) => id !== 'm2image-source:rocky:aarch64'),
  };
  assert.throws(() => nativeDispatchJobs(weakened, SOURCE), /not in the admitted mandatory set/);
});

test('dispatcher refuses a plan/source object mismatch', async () => {
  const admission = await admitFireCrabAssurancePlan(planText(), SHA);
  assert.throws(
    () => nativeDispatchJobs(admission, { ...SOURCE, sha: 'b'.repeat(40) }),
    /plan\/source sha mismatch/,
  );
});

test('private Shell dispatch carries semantic requirements, evidence path, and deterministic request identity', async () => {
  const admission = await admitFireCrabAssurancePlan(planText(), SHA);
  const job = nativeDispatchJobs(admission, SOURCE)[0];
  const seen: Request[] = [];
  const buildId = '123e4567-e89b-42d3-a456-426614174000';
  let observedRequestId = '';
  const shell: ShellService = {
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input);
      seen.push(request.clone());
      const url = new URL(request.url);
      if (url.pathname === '/internal/v1/approvals') {
        return Response.json({
          id: 'approval:123e4567-e89b-42d3-a456-426614174001',
          workspaceId: assuranceWorkspaceId('firecrab', SHA),
          capability: 'shell.build.trigger',
        }, { status: 201 });
      }
      const body = await request.json() as Record<string, unknown>;
      observedRequestId = String(body.requestId);
      assert.match(observedRequestId, /^[0-9a-f-]{36}$/);
      assert.equal(body.evidencePath, job.evidence);
      const source = body.source as Record<string, unknown>;
      assert.equal(source.sha, SHA);
      assert.equal('token' in source, false);
      assert.equal('remote' in source, false);
      assert.equal((body.requirements as Record<string, unknown>).architecture, job.architecture);
      return Response.json({
        requestId: observedRequestId,
        buildId,
        architecture: job.architecture,
        evidencePath: job.evidence,
        source: job.source,
      }, { status: 201 });
    },
  };

  const workspaceId = assuranceWorkspaceId('firecrab', SHA);
  const first = await dispatchNativeJob(shell, workspaceId, job);
  const second = await dispatchNativeJob(shell, workspaceId, job);
  assert.equal(first.buildId, buildId);
  assert.equal(first.requestId, second.requestId);
  assert.equal(seen.length, 4);
  assert.equal(new URL(seen[0].url).pathname, '/internal/v1/approvals');
  assert.match(new URL(seen[1].url).pathname, /\/assurance-builds$/);
  assert.equal(seen[1].headers.get('x-scumm-shell-admission'), 'approved');
});

test('evidence parser binds result JSON to job, source SHA, and architecture', async () => {
  const admission = await admitFireCrabAssurancePlan(planText(), SHA);
  const job = nativeDispatchJobs(admission, SOURCE)[0];
  const active = dispatched(job);
  const payload = evidencePayload(job);
  const log = {
    consoleTruncated: false,
    console: [
      'command output',
      `SCUMM_ASSURANCE_EVIDENCE_BEGIN ${job.evidence}`,
      JSON.stringify(payload, null, 2),
      `SCUMM_ASSURANCE_EVIDENCE_END ${job.evidence}`,
    ].join('\n'),
  };
  assert.deepEqual(extractNativeEvidence(active, log), payload);

  const wrong = structuredClone(payload);
  (wrong.subject as Record<string, unknown>).sha = 'b'.repeat(40);
  assert.throws(() => extractNativeEvidence(active, {
    consoleTruncated: false,
    console: [
      `SCUMM_ASSURANCE_EVIDENCE_BEGIN ${job.evidence}`,
      JSON.stringify(wrong),
      `SCUMM_ASSURANCE_EVIDENCE_END ${job.evidence}`,
    ].join('\n'),
  }), /changed source SHA\/architecture/);

  assert.throws(() => extractNativeEvidence(active, {
    consoleTruncated: false,
    console: `SCUMM_ASSURANCE_EVIDENCE_MISSING ${job.evidence}`,
  }), /evidence is missing/);
});

test('status and log reads stay bound to the architecture selected at trigger', async () => {
  const admission = await admitFireCrabAssurancePlan(planText(), SHA);
  const job = nativeDispatchJobs(admission, SOURCE).find((item) => item.architecture === 'aarch64')!;
  const active = dispatched(job);
  const paths: string[] = [];
  const shell: ShellService = {
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith('/log')) {
        return Response.json({
          architecture: 'aarch64',
          buildId: active.buildId,
          complete: true,
          exitCode: 0,
          consoleTruncated: false,
          console: [
            `SCUMM_ASSURANCE_EVIDENCE_BEGIN ${job.evidence}`,
            JSON.stringify(evidencePayload(job)),
            `SCUMM_ASSURANCE_EVIDENCE_END ${job.evidence}`,
          ].join('\n'),
        });
      }
      return Response.json({
        architecture: 'aarch64',
        buildId: active.buildId,
        complete: true,
        conclusion: 'success',
        exitCode: 0,
      });
    },
  };
  await readNativeJobStatus(shell, active);
  const log = await readNativeJobLog(shell, active);
  assert.equal((log.assuranceEvidence as Record<string, unknown>).verdict, 'PASS');
  assert.ok(paths[0].includes(`/assurance-builds/aarch64/${active.buildId}`));
  assert.ok(paths[1].endsWith(`/assurance-builds/aarch64/${active.buildId}/log`));
});
