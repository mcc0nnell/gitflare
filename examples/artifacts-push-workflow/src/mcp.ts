import type { CiParams, CloudflareArtifacts } from '@cloudflare/ci';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { admitFireCrabAssurancePlan } from '../assurance-policy';
import type { Bindings } from '../env';

const NAMESPACE = 'gitflare';
const PROVIDER = 'cloudflare-artifacts';
const MAX_ASSURANCE_PLAN_BYTES = 256 * 1024;
const MAX_ASSURANCE_ADMISSION_BYTES = 64 * 1024;
const MAX_ASSURANCE_RECEIPT_BYTES = 512 * 1024;
const EXPECTED_ASSURANCE_COMPONENTS = 11;

const shaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/i, 'sha must be a 40- or 64-character hex Git object id');

const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,96}$/, 'repo must contain only letters, digits, dot, underscore, or hyphen');

const refSchema = z
  .string()
  .refine(
    (value) => value.startsWith('refs/heads/') || value.startsWith('refs/tags/'),
    'ref must start with refs/heads/ or refs/tags/',
  );

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown CI error';
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function canonicalRepo(repo: string): string {
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(repo)) {
    throw new Error(`invalid assurance repository name: ${repo}`);
  }
  return repo.toLowerCase();
}

function canonicalSha(sha: string): string {
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(sha)) {
    throw new Error('invalid assurance Git object id');
  }
  return sha.toLowerCase();
}

function assuranceAdmissionKey(repo: string, sha: string) {
  return `assurance-admissions/${canonicalRepo(repo)}/${canonicalSha(sha)}.json`;
}

function assuranceReceiptKey(kind: 'native' | 'final', repo: string, sha: string, planDigest: string) {
  const digest = planDigest.replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid assurance plan digest');
  return `assurance-${kind}/${canonicalRepo(repo)}/${canonicalSha(sha)}/${digest}.json`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function readBoundedObject(
  env: Bindings,
  key: string,
  maxBytes: number,
  label: string,
): Promise<Record<string, unknown> | null> {
  const object = await env.BACKUP_BUCKET.get(key);
  if (object === null) return null;
  if (object.size > maxBytes) throw new Error(`${label} exceeds maximum size`);
  let value: unknown;
  try {
    value = JSON.parse(await object.text());
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
  return record(value, label);
}

async function authorized(request: Request, env: Bindings): Promise<boolean> {
  const token = env.GITFLARE_CI_MCP_TOKEN;
  if (typeof token !== 'string' || token.length === 0) return false;

  const encoder = new TextEncoder();
  const provided = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${token}`;
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function ciParams(input: {
  repo: string;
  sha: string;
  ref: string;
  beforeSha?: string;
  headCommitMessage?: string;
  actor?: string;
}): CiParams<CloudflareArtifacts> {
  const isTag = input.ref.startsWith('refs/tags/');
  return {
    provider: PROVIDER,
    providerData: { namespace: NAMESPACE },
    event: { type: isTag ? 'tag' : 'push' },
    owner: NAMESPACE,
    repo: input.repo,
    sha: input.sha,
    remote: 'cloudflare',
    trigger: isTag ? 'tag' : 'push',
    ref: input.ref,
    branch: isTag ? undefined : input.ref.slice('refs/heads/'.length),
    tag: isTag ? input.ref.slice('refs/tags/'.length) : undefined,
    beforeSha: input.beforeSha,
    headCommitMessage: input.headCommitMessage,
    actor: input.actor,
  };
}

// Compatibility contract with @cloudflare/ci 0.1.0's internal source-derived
// Workflow ID. Keep this local only until the upstream package exports a public
// helper; MCP-started and push-triggered runs must resolve to the same instance.
async function runId(source: { provider: string; owner: string; repo: string; sha: string }) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([source.provider, source.owner, source.repo, source.sha.toLowerCase()]),
    ),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const provider = slugify(source.provider).slice(0, 12) || 'source';
  const repo = slugify(source.repo).slice(0, 16) || 'repo';
  return `ci-${provider}-${repo}-${hex}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function readAdmittedAssurancePlan(env: Bindings, rawRepo: string, rawSha: string) {
  const repo = canonicalRepo(rawRepo);
  const sha = canonicalSha(rawSha);
  const admissionObject = await env.BACKUP_BUCKET.get(assuranceAdmissionKey(repo, sha));
  if (admissionObject === null) return null;
  if (admissionObject.size > MAX_ASSURANCE_ADMISSION_BYTES) {
    throw new Error('persisted assurance admission exceeds maximum size');
  }

  const admission = record(JSON.parse(await admissionObject.text()), 'persisted assurance admission');
  const policy = record(admission.policy, 'persisted assurance policy');
  if (
    admission.schemaVersion !== 1
    || String(admission.repo ?? '').toLowerCase() !== repo
    || String(admission.sha ?? '').toLowerCase() !== sha
    || typeof admission.planKey !== 'string'
    || typeof admission.planDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(admission.planDigest)
    || typeof policy.id !== 'string'
    || typeof policy.digest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(policy.digest)
  ) {
    throw new Error('persisted assurance admission is invalid');
  }
  const expectedPrefix = `assurance-plans/${repo}/${sha}/`;
  if (!admission.planKey.startsWith(expectedPrefix)) {
    throw new Error('persisted assurance admission points outside the admitted subject namespace');
  }

  const planObject = await env.BACKUP_BUCKET.get(admission.planKey);
  if (planObject === null) throw new Error('admitted assurance plan object is missing');
  if (planObject.size > MAX_ASSURANCE_PLAN_BYTES) {
    throw new Error('persisted assurance plan exceeds maximum size');
  }
  const planText = await planObject.text();

  const admitted = await admitFireCrabAssurancePlan(planText, sha);
  if (
    admitted.planDigest !== admission.planDigest
    || admitted.policyId !== policy.id
    || admitted.policyDigest !== policy.digest
  ) {
    throw new Error('persisted assurance admission failed digest/policy verification');
  }
  return { repo, sha, admission, plan: admitted.plan };
}

function validateNativeReceipt(
  value: Record<string, unknown>,
  repo: string,
  sha: string,
  planDigest: string,
): Record<string, unknown> {
  if (
    value.schemaVersion !== 1
    || value.profile !== 'firecrab-release-assurance-v1'
    || String(value.repo ?? '').toLowerCase() !== repo
    || String(value.sha ?? '').toLowerCase() !== sha
    || value.planDigest !== planDigest
    || value.nativeJobCount !== 10
    || !Array.isArray(value.jobs)
    || value.jobs.length !== 10
  ) {
    throw new Error('native assurance receipt identity/coverage is invalid');
  }
  return value;
}

function validateFinalReceipt(
  value: Record<string, unknown>,
  admitted: NonNullable<Awaited<ReturnType<typeof readAdmittedAssurancePlan>>>,
): Record<string, unknown> {
  const policy = record(value.policy, 'final assurance policy');
  const admittedPolicy = record(admitted.admission.policy, 'admitted assurance policy');
  if (
    value.schemaVersion !== 1
    || value.profile !== 'firecrab-release-assurance-v1'
    || String(value.repo ?? '').toLowerCase() !== admitted.repo
    || String(value.sha ?? '').toLowerCase() !== admitted.sha
    || value.verdict !== 'PASS'
    || value.planDigest !== admitted.admission.planDigest
    || policy.id !== admittedPolicy.id
    || policy.digest !== admittedPolicy.digest
    || typeof value.nativeReceipt !== 'string'
  ) {
    throw new Error('final assurance receipt identity/policy is invalid');
  }

  const aggregate = record(value.aggregate, 'final aggregate assurance verdict');
  const counts = record(aggregate.counts, 'final aggregate assurance counts');
  if (
    aggregate.schemaVersion !== 1
    || aggregate.profile !== 'firecrab-release-assurance-v1'
    || String(aggregate.sha ?? '').toLowerCase() !== admitted.sha
    || aggregate.verdict !== 'PASS'
    || !Array.isArray(aggregate.components)
    || aggregate.components.length !== EXPECTED_ASSURANCE_COMPONENTS
    || counts.PASS !== EXPECTED_ASSURANCE_COMPONENTS
    || counts.FAIL !== 0
    || counts.BLOCKED !== 0
  ) {
    throw new Error('final aggregate assurance verdict is incomplete or not PASS');
  }
  return value;
}

async function readAssuranceResult(env: Bindings, repoInput: string, shaInput: string) {
  const admitted = await readAdmittedAssurancePlan(env, repoInput, shaInput);
  const repo = canonicalRepo(repoInput);
  const sha = canonicalSha(shaInput);
  if (admitted === null) {
    return { found: false, certified: false, stage: 'admission', repo, sha };
  }

  const planDigest = String(admitted.admission.planDigest);
  const finalKey = assuranceReceiptKey('final', repo, sha, planDigest);
  const final = await readBoundedObject(
    env,
    finalKey,
    MAX_ASSURANCE_RECEIPT_BYTES,
    'final assurance receipt',
  );
  if (final !== null) {
    const receipt = validateFinalReceipt(final, admitted);
    const expectedNativeKey = assuranceReceiptKey('native', repo, sha, planDigest);
    if (receipt.nativeReceipt !== expectedNativeKey) {
      throw new Error('final assurance receipt points at the wrong native receipt');
    }
    const native = await readBoundedObject(
      env,
      expectedNativeKey,
      MAX_ASSURANCE_RECEIPT_BYTES,
      'native assurance receipt',
    );
    if (native === null) throw new Error('final assurance receipt references missing native evidence');
    validateNativeReceipt(native, repo, sha, planDigest);
    return {
      found: true,
      certified: true,
      stage: 'final',
      repo,
      sha,
      policy: admitted.admission.policy,
      planDigest,
      receiptKey: finalKey,
      receipt,
    };
  }

  const nativeKey = assuranceReceiptKey('native', repo, sha, planDigest);
  const native = await readBoundedObject(
    env,
    nativeKey,
    MAX_ASSURANCE_RECEIPT_BYTES,
    'native assurance receipt',
  );
  if (native === null) {
    return {
      found: true,
      certified: false,
      stage: 'native-pending',
      repo,
      sha,
      policy: admitted.admission.policy,
      planDigest,
    };
  }
  return {
    found: true,
    certified: false,
    stage: 'native',
    repo,
    sha,
    policy: admitted.admission.policy,
    planDigest,
    receiptKey: nativeKey,
    receipt: validateNativeReceipt(native, repo, sha, planDigest),
  };
}

function createCiMcpServer(env: Bindings) {
  const server = new McpServer({ name: 'gitflare-ci', version: '0.2.0' });

  server.registerTool(
    'ci_run_start',
    {
      title: 'Start CI run',
      description:
        'Start the Gitflare Cloudflare CI workflow for a Git commit in the gitflare Artifacts namespace. Idempotent for the same repository and commit.',
      inputSchema: z.object({
        repo: repoSchema.describe('Artifacts repository name'),
        sha: shaSchema.describe('Git commit object id'),
        ref: refSchema.describe('Full Git ref, for example refs/heads/main'),
        beforeSha: shaSchema.optional().describe('Previous Git object id, when known'),
        headCommitMessage: z.string().optional(),
        actor: z.string().optional(),
      }),
      annotations: {
        title: 'Start CI run',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const params = ciParams(input);
        const id = await runId(params);
        const [created] = await env.CI_WORKFLOW.createBatch([{ id, params }]);
        const instance = created ?? (await env.CI_WORKFLOW.get(id));
        return result({ id, created: Boolean(created), ...(await instance.status()) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'ci_run_status',
    {
      title: 'Get CI run status',
      description: 'Get the current Cloudflare Workflow status for a Gitflare CI run.',
      inputSchema: z.object({ id: z.string().min(1).describe('CI Workflow instance id') }),
      annotations: {
        title: 'Get CI run status',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id }) => {
      try {
        const instance = await env.CI_WORKFLOW.get(id);
        return result({ id, ...(await instance.status()) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'ci_assurance_plan',
    {
      title: 'Get admitted assurance plan',
      description:
        'Read an externally policy-admitted, digest-verified assurance plan for a successful source-bound preflight.',
      inputSchema: z.object({
        repo: repoSchema.describe('Artifacts repository name'),
        sha: shaSchema.describe('Git commit object id'),
      }),
      annotations: {
        title: 'Get admitted assurance plan',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ repo, sha }) => {
      try {
        const admitted = await readAdmittedAssurancePlan(env, repo, sha);
        if (admitted === null) return result({ found: false, repo, sha });
        return result({ found: true, repo: admitted.repo, sha: admitted.sha, admission: admitted.admission, plan: admitted.plan });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'ci_assurance_result',
    {
      title: 'Get assurance certification result',
      description:
        'Verify and return the externally admitted FireCrab native assurance result. certified=true is returned only for a policy/digest-verified 11-component PASS receipt.',
      inputSchema: z.object({
        repo: repoSchema.describe('Artifacts repository name'),
        sha: shaSchema.describe('Git commit object id'),
      }),
      annotations: {
        title: 'Get assurance certification result',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ repo, sha }) => {
      try {
        return result(await readAssuranceResult(env, repo, sha));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'ci_run_retry',
    {
      title: 'Retry CI run',
      description:
        'Restart a Gitflare CI workflow from the beginning or from a named durable Workflow step.',
      inputSchema: z.object({
        id: z.string().min(1).describe('CI Workflow instance id'),
        fromStep: z.string().min(1).optional().describe('Optional Workflow step name'),
        count: z.number().int().min(1).optional().describe('1-based occurrence of fromStep'),
        type: z.enum(['do', 'sleep', 'waitForEvent']).optional(),
      }),
      annotations: {
        title: 'Retry CI run',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ id, fromStep, count, type }) => {
      try {
        const instance = await env.CI_WORKFLOW.get(id);
        if (fromStep) {
          await instance.restart({ from: { name: fromStep, count, type } });
        } else {
          await instance.restart();
        }
        return result({ id, restarted: true, ...(await instance.status()) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'ci_run_cancel',
    {
      title: 'Cancel CI run',
      description: 'Terminate a running Gitflare CI workflow, optionally executing rollback handlers.',
      inputSchema: z.object({
        id: z.string().min(1).describe('CI Workflow instance id'),
        rollback: z.boolean().default(false),
      }),
      annotations: {
        title: 'Cancel CI run',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ id, rollback }) => {
      try {
        const instance = await env.CI_WORKFLOW.get(id);
        await instance.terminate({ rollback });
        return result({ id, terminated: true, ...(await instance.status()) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export async function handleCiMcpRequest(request: Request, env: Bindings): Promise<Response> {
  const rejected =
    hostHeaderValidationResponse(request, [env.GITFLARE_CI_MCP_HOST]) ??
    originValidationResponse(request, []);
  if (rejected) return rejected;

  if (!(await authorized(request, env))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const handler = createMcpHandler(() => createCiMcpServer(env), { maxSubscriptions: 0 });
  return handler.fetch(request);
}
