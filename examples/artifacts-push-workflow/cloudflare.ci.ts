import { CIWorkflow } from '@cloudflare/ci';
import type { CiContext, CiParams, CloudflareArtifacts } from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Bindings } from './env';

const GIT_OBJECT_ID = /^[a-f0-9]{40}([a-f0-9]{24})?$/i;
const ASSURANCE_REPO = /^[A-Za-z0-9._-]{1,96}$/;
const PREFLIGHT_STEP_TIMEOUT_MS = 31 * 60 * 1000;
const PREFLIGHT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_ASSURANCE_PLAN_BYTES = 256 * 1024;

function assurancePlanKey(repo: string, sha: string) {
  if (!ASSURANCE_REPO.test(repo)) {
    throw new Error(`invalid assurance repository name: ${repo}`);
  }
  return `assurance-plans/${repo.toLowerCase()}/${sha.toLowerCase()}.json`;
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

function validateAssurancePlan(text: string, sha: string) {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) {
    throw new Error('assurance plan is not a JSON object');
  }
  const plan = value as Record<string, unknown>;
  if (plan.schemaVersion !== 1 || plan.sha !== sha) {
    throw new Error('assurance plan subject does not match the CI source revision');
  }
  if (!Array.isArray(plan.jobs) || plan.jobs.length === 0) {
    throw new Error('assurance plan contains no jobs');
  }
  if (plan.jobCount !== plan.jobs.length) {
    throw new Error('assurance plan jobCount does not match jobs');
  }
  return text;
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

    // Project policy lives with the project. Gitflare only chooses the profile;
    // FireCrab owns and versions the release-compliance contract that is run.
    // Chaining from verify-source reuses only this run's clean snapshot; there
    // is deliberately no cross-run dependency cache for the preflight.
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

      // Read only the project-emitted work plan from the successful preflight
      // snapshot. Gitflare persists it by source SHA so TalkPipe can consume the
      // matrix without Gitflare learning FireCrab-specific assurance policy.
      const planOutput = await preflight.runner({
        name: 'read-assurance-plan',
        command: 'cat dist/gitflare-receipts/assurance-plan.json',
        env: { GITFLARE_EXPECTED_SHA: sha },
      });
      const planText = validateAssurancePlan(
        await readBoundedLog(planOutput.logs.stdout),
        sha,
      );
      await this.env.BACKUP_BUCKET.put(assurancePlanKey(repo, sha), planText, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { repo, sha },
      });
    }
  }
}
