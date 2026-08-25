import { CIWorkflow } from '@cloudflare/ci';
import type { CiContext, CiParams, CloudflareArtifacts } from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { admitFireCrabAssurancePlan } from './assurance-policy';
import type { Bindings } from './env';

const GIT_OBJECT_ID = /^[a-f0-9]{40}([a-f0-9]{24})?$/i;
const ASSURANCE_REPO = /^[A-Za-z0-9._-]{1,96}$/;
const PREFLIGHT_STEP_TIMEOUT_MS = 31 * 60 * 1000;
const PREFLIGHT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_ASSURANCE_PLAN_BYTES = 256 * 1024;

function normalizedRepo(repo: string): string {
  if (!ASSURANCE_REPO.test(repo)) {
    throw new Error(`invalid assurance repository name: ${repo}`);
  }
  return repo.toLowerCase();
}

function assuranceAdmissionKey(repo: string, sha: string) {
  return `assurance-admissions/${normalizedRepo(repo)}/${sha.toLowerCase()}.json`;
}

function assurancePlanObjectKey(repo: string, sha: string, planDigest: string) {
  const digest = planDigest.replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid assurance plan digest');
  return `assurance-plans/${normalizedRepo(repo)}/${sha.toLowerCase()}/${digest}.json`;
}

async function readBoundedLog(
  value: string | ReadableStream<Uint8Array>,
  maxBytes = MAX_ASSURANCE_PLAN_BYTES,
): Promise<string> {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > maxBytes) {
      throw new Error('assurance plan exceeds maximum size');
    }
    return value;
  }

  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel('assurance plan exceeds maximum size');
        throw new Error('assurance plan exceeds maximum size');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function persistAdmittedPlan(env: Bindings, repo: string, sha: string, planText: string) {
  const admitted = await admitFireCrabAssurancePlan(planText, sha);
  const planKey = assurancePlanObjectKey(repo, sha, admitted.planDigest);
  const pointerKey = assuranceAdmissionKey(repo, sha);
  const envelope = {
    schemaVersion: 1,
    repo,
    sha,
    planDigest: admitted.planDigest,
    planKey,
    policy: {
      id: admitted.policyId,
      digest: admitted.policyDigest,
    },
    mandatoryJobIds: admitted.mandatoryJobIds,
  };
  const envelopeText = JSON.stringify(envelope, null, 2) + '\n';

  // The plan object is content-addressed. Re-observing the same source and plan
  // is harmless; a different plan necessarily maps to a different object key.
  const existingPlan = await env.BACKUP_BUCKET.get(planKey);
  if (existingPlan !== null) {
    if (existingPlan.size > MAX_ASSURANCE_PLAN_BYTES || (await existingPlan.text()) !== planText) {
      throw new Error('content-addressed assurance plan collision');
    }
  } else {
    await env.BACKUP_BUCKET.put(planKey, planText, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        repo,
        sha,
        planDigest: admitted.planDigest,
        policyId: admitted.policyId,
        policyDigest: admitted.policyDigest,
      },
    });
  }

  // First admission for a source object wins. A rerun may confirm the exact
  // same plan/policy admission but can never replace it with weaker coverage.
  const existingAdmission = await env.BACKUP_BUCKET.get(pointerKey);
  if (existingAdmission !== null) {
    const existingText = await existingAdmission.text();
    if (existingText !== envelopeText) {
      throw new Error('assurance admission collision: this Git object already has a different admitted plan');
    }
  } else {
    await env.BACKUP_BUCKET.put(pointerKey, envelopeText, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        repo,
        sha,
        planDigest: admitted.planDigest,
        policyId: admitted.policyId,
        policyDigest: admitted.policyDigest,
      },
    });
  }

  return envelope;
}

export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(
    event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const { repo, sha } = event.payload;
    if (!GIT_OBJECT_ID.test(sha)) {
      throw new Error(`invalid source object id: ${sha}`);
    }

    // First establish the provider/source invariant in a fresh sandbox. Do not
    // attach a cache here: this is the boundary that proves the exact revision
    // emitted by Cloudflare Artifacts is the revision being executed.
    const source = await ci.runner({
      name: 'verify-source',
      command:
        'test "$(git rev-parse HEAD)" = "$GITFLARE_EXPECTED_SHA" && git fsck --no-reflogs --connectivity-only',
      env: { GITFLARE_EXPECTED_SHA: sha },
    });

    if (repo === 'firecrab') {
      const preflight = await source.runner({
        name: 'release-compliance-preflight',
        command: 'bash scripts/gitflare-release-compliance.sh',
        env: { GITFLARE_EXPECTED_SHA: sha },
        config: {
          timeout: PREFLIGHT_STEP_TIMEOUT_MS,
          commandTimeoutMs: PREFLIGHT_COMMAND_TIMEOUT_MS,
        },
      });

      // FireCrab may describe richer project-specific assurance, but admission
      // is controlled here. The subject cannot delete or weaken the externally
      // anchored minimum matrix and still obtain a persisted work plan.
      const planOutput = await preflight.runner({
        name: 'read-assurance-plan',
        command: 'cat dist/gitflare-receipts/assurance-plan.json',
        env: { GITFLARE_EXPECTED_SHA: sha },
      });
      const planText = await readBoundedLog(planOutput.logs.stdout);
      await persistAdmittedPlan(this.env, repo, sha, planText);
    }
  }
}
