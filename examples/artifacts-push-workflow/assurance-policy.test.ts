import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitFireCrabAssurancePlan,
  FIRECRAB_MINIMUM_POLICY,
} from './assurance-policy.ts';

const SHA = 'a'.repeat(40);

function validPlan(): Record<string, unknown> {
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
      dependsOn: ['release-compliance-preflight'],
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
      dependsOn: ['release-compliance-preflight'],
    });
  }

  jobs.push({
    ...FIRECRAB_MINIMUM_POLICY.aggregate,
    env: { GITFLARE_EXPECTED_SHA: SHA },
    dependsOn: nativeIds,
  });
  return {
    schemaVersion: 1,
    profile: FIRECRAB_MINIMUM_POLICY.subjectProfile,
    sha: SHA,
    jobCount: jobs.length,
    nativeJobCount: nativeIds.length,
    jobs,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('external minimum policy admits the complete FireCrab matrix', async () => {
  const plan = validPlan();
  const admitted = await admitFireCrabAssurancePlan(JSON.stringify(plan), SHA);
  assert.equal(admitted.policyId, 'gitflare/firecrab-release-minimum-v1');
  assert.equal(admitted.mandatoryJobIds.length, 12);
  assert.match(admitted.planDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(admitted.policyDigest, /^sha256:[a-f0-9]{64}$/);
});

test('subject cannot delete a mandatory native proof', async () => {
  const plan = clone(validPlan()) as { jobs: Record<string, unknown>[]; jobCount: number; nativeJobCount: number };
  plan.jobs = plan.jobs.filter((job) => job.id !== 'm2image-source:rocky:aarch64');
  plan.jobCount = plan.jobs.length;
  plan.nativeJobCount -= 1;
  await assert.rejects(
    admitFireCrabAssurancePlan(JSON.stringify(plan), SHA),
    /minimum native proof count|missing mandatory job/,
  );
});

test('subject cannot relabel architecture or libc', async () => {
  const plan = clone(validPlan()) as { jobs: Record<string, unknown>[] };
  const host = plan.jobs.find((job) => job.id === 'host-release:aarch64-unknown-linux-musl')!;
  (host.constraints as Record<string, unknown>).architecture = 'x86_64';
  await assert.rejects(
    admitFireCrabAssurancePlan(JSON.stringify(plan), SHA),
    /unexpected constraint architecture/,
  );

  const plan2 = clone(validPlan()) as { jobs: Record<string, unknown>[] };
  const host2 = plan2.jobs.find((job) => job.id === 'host-release:x86_64-unknown-linux-musl')!;
  (host2.constraints as Record<string, unknown>).libc = 'gnu';
  await assert.rejects(
    admitFireCrabAssurancePlan(JSON.stringify(plan2), SHA),
    /unexpected constraint libc/,
  );
});

test('subject cannot change command or evidence path', async () => {
  const plan = clone(validPlan()) as { jobs: Record<string, unknown>[] };
  const job = plan.jobs.find((candidate) => candidate.id === 'm2image-source:rocky:x86_64')!;
  job.command = 'true';
  await assert.rejects(admitFireCrabAssurancePlan(JSON.stringify(plan), SHA), /unexpected command/);

  const plan2 = clone(validPlan()) as { jobs: Record<string, unknown>[] };
  const job2 = plan2.jobs.find((candidate) => candidate.id === 'host-release:x86_64-unknown-linux-gnu')!;
  job2.evidence = '/tmp/fake.json';
  await assert.rejects(admitFireCrabAssurancePlan(JSON.stringify(plan2), SHA), /unexpected evidence/);
});

test('aggregate must cover every mandatory native proof', async () => {
  const plan = clone(validPlan()) as { jobs: Record<string, unknown>[] };
  const aggregate = plan.jobs.find((job) => job.id === 'aggregate')!;
  aggregate.dependsOn = (aggregate.dependsOn as string[]).filter((id) => id !== 'host-release:aarch64-unknown-linux-gnu');
  await assert.rejects(
    admitFireCrabAssurancePlan(JSON.stringify(plan), SHA),
    /aggregate is not bound to mandatory proof/,
  );
});

test('project may add stronger evidence without weakening the minimum', async () => {
  const plan = clone(validPlan()) as { jobs: Record<string, unknown>[]; jobCount: number; nativeJobCount: number };
  plan.jobs.push({
    id: 'project-extra:adversary',
    stage: 'project-extra',
    runnerClass: 'native',
    command: 'bash scripts/project-extra.sh',
    env: { GITFLARE_EXPECTED_SHA: SHA },
    evidence: 'dist/assurance/project-extra/result.json',
    dependsOn: ['release-compliance-preflight'],
  });
  plan.jobCount += 1;
  const admitted = await admitFireCrabAssurancePlan(JSON.stringify(plan), SHA);
  assert.equal(admitted.mandatoryJobIds.includes('project-extra:adversary'), false);
});
