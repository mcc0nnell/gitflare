import { Buffer } from 'node:buffer';
import { CIWorkflow } from '@cloudflare/ci';
import type { CiContext, CiParams, CloudflareArtifacts } from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import {
  assuranceWorkspaceId,
  dispatchNativeJob,
  nativeDispatchJobs,
  nativeStatusSucceeded,
  nativeStatusTerminal,
  readNativeJobLog,
  readNativeJobStatus,
  type AssuranceSourceIdentity,
  type DispatchedNativeJob,
} from './assurance-dispatch';
import { admitFireCrabAssurancePlan } from './assurance-policy';
import type { Bindings } from './env';

const GIT_OBJECT_ID = /^[a-f0-9]{40}([a-f0-9]{24})?$/i;
const ASSURANCE_REPO = /^[A-Za-z0-9._-]{1,96}$/;
const PREFLIGHT_STEP_TIMEOUT_MS = 31 * 60 * 1000;
const PREFLIGHT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_ASSURANCE_PLAN_BYTES = 256 * 1024;
const MAX_NATIVE_EVIDENCE_BUNDLE_BYTES = 256 * 1024;
const NATIVE_POLL_ROUNDS = 240;
const NATIVE_POLL_DELAY = '30 seconds';
const AGGREGATE_COMMAND =
  'python3 scripts/assemble_assurance.py --root dist/assurance --preflight dist/gitflare-receipts/verdict.json';
const MATERIALIZE_NATIVE_EVIDENCE = `python3 - <<'PY'
import base64
import json
import os
from pathlib import Path

items = json.loads(base64.b64decode(os.environ["GITFLARE_NATIVE_EVIDENCE_B64"]).decode("utf-8"))
if not isinstance(items, list) or len(items) != 10:
    raise SystemExit("expected exactly ten native evidence documents")
seen = set()
for item in items:
    if not isinstance(item, dict) or set(item) != {"path", "document"}:
        raise SystemExit("invalid native evidence materialization item")
    raw = item["path"]
    if not isinstance(raw, str) or not raw.startswith("dist/assurance/"):
        raise SystemExit("native evidence path escaped dist/assurance")
    path = Path(raw)
    if path.is_absolute() or ".." in path.parts or path.name != "result.json" or raw in seen:
        raise SystemExit("native evidence path is not admitted")
    seen.add(raw)
    document = item["document"]
    if not isinstance(document, dict):
        raise SystemExit("native evidence document is not an object")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
PY`;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function normalizedRepo(repo: string): string {
  if (!ASSURANCE_REPO.test(repo)) {
    throw new Error(`invalid assurance repository name: ${repo}`);
  }
  return repo.toLowerCase();
}

function normalizedRef(ref: unknown): string {
  if (
    typeof ref !== 'string'
    || !(ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))
    || /[\u0000-\u001f\u007f]/.test(ref)
  ) {
    throw new Error(`invalid assurance source ref: ${String(ref)}`);
  }
  return ref;
}

function assuranceAdmissionKey(repo: string, sha: string) {
  return `assurance-admissions/${normalizedRepo(repo)}/${sha.toLowerCase()}.json`;
}

function assurancePlanObjectKey(repo: string, sha: string, planDigest: string) {
  const digest = planDigest.replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid assurance plan digest');
  return `assurance-plans/${normalizedRepo(repo)}/${sha.toLowerCase()}/${digest}.json`;
}

function nativeReceiptKey(repo: string, sha: string, planDigest: string) {
  const digest = planDigest.replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid assurance plan digest');
  return `assurance-native/${normalizedRepo(repo)}/${sha.toLowerCase()}/${digest}.json`;
}

function finalReceiptKey(repo: string, sha: string, planDigest: string) {
  const digest = planDigest.replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid assurance plan digest');
  return `assurance-final/${normalizedRepo(repo)}/${sha.toLowerCase()}/${digest}.json`;
}

async function readBoundedLog(
  value: string | ReadableStream<Uint8Array>,
  maxBytes = MAX_ASSURANCE_PLAN_BYTES,
): Promise<string> {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > maxBytes) {
      throw new Error('assurance output exceeds maximum size');
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
        await reader.cancel('assurance output exceeds maximum size');
        throw new Error('assurance output exceeds maximum size');
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

  return admitted;
}

function stableStatus(status: JsonRecord): JsonRecord {
  return Object.fromEntries([
    'buildId', 'runner', 'vmName', 'vmState', 'phase', 'conclusion', 'exitCode', 'complete', 'consoleTruncated', 'architecture',
  ].flatMap((key) => key in status ? [[key, status[key]]] : []));
}

function stableLog(log: JsonRecord): JsonRecord {
  return Object.fromEntries([
    'buildId', 'vmName', 'complete', 'exitCode', 'consoleTruncated', 'architecture', 'assuranceEvidence', 'evidenceError',
  ].flatMap((key) => key in log ? [[key, log[key]]] : []));
}

async function persistNativeReceipt(
  env: Bindings,
  repo: string,
  sha: string,
  planDigest: string,
  dispatched: DispatchedNativeJob[],
  statuses: Array<{ jobId: string; status: JsonRecord }>,
  logs: Array<{ jobId: string; log: JsonRecord }>,
  timedOut: boolean,
): Promise<string> {
  const key = nativeReceiptKey(repo, sha, planDigest);
  const receipt = {
    schemaVersion: 1,
    profile: 'firecrab-release-assurance-v1',
    repo,
    sha,
    planDigest,
    timedOut,
    nativeJobCount: dispatched.length,
    allTerminal: statuses.every(({ status }) => nativeStatusTerminal(status)),
    allSucceeded: statuses.every(({ status }) => nativeStatusSucceeded(status)),
    jobs: dispatched.map((job) => ({
      ...job,
      status: stableStatus(statuses.find((item) => item.jobId === job.jobId)?.status ?? {}),
      log: stableLog(logs.find((item) => item.jobId === job.jobId)?.log ?? {}),
    })),
  };
  const text = JSON.stringify(receipt, null, 2) + '\n';
  const existing = await env.BACKUP_BUCKET.get(key);
  if (existing !== null) {
    const previous = await existing.text();
    if (previous !== text) {
      throw new Error('native assurance receipt collision for admitted plan');
    }
    return key;
  }
  await env.BACKUP_BUCKET.put(key, text, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { repo, sha, planDigest },
  });
  return key;
}

function nativeEvidenceBundle(
  dispatched: DispatchedNativeJob[],
  logs: Array<{ jobId: string; log: JsonRecord }>,
): Array<{ path: string; document: JsonRecord }> {
  const bundle = dispatched.map((job) => {
    const log = logs.find((item) => item.jobId === job.jobId)?.log;
    const evidence = record(log?.assuranceEvidence, `validated native evidence for ${job.jobId}`);
    if (evidence.verdict !== 'PASS') {
      throw new Error(`native evidence is not PASS for ${job.jobId}: ${String(evidence.verdict)}`);
    }
    return { path: job.evidence, document: evidence };
  });
  const encoded = new TextEncoder().encode(JSON.stringify(bundle));
  if (encoded.byteLength > MAX_NATIVE_EVIDENCE_BUNDLE_BYTES) {
    throw new Error('native assurance evidence bundle exceeds maximum size');
  }
  return bundle;
}

function validateAggregateVerdict(value: unknown, sha: string, expectedComponents: number): JsonRecord {
  const verdict = record(value, 'aggregate assurance verdict');
  if (
    verdict.schemaVersion !== 1
    || verdict.profile !== 'firecrab-release-assurance-v1'
    || verdict.sha !== sha
    || verdict.verdict !== 'PASS'
  ) {
    throw new Error('aggregate assurance verdict did not certify the admitted source');
  }
  if (!Array.isArray(verdict.components) || verdict.components.length !== expectedComponents) {
    throw new Error('aggregate assurance verdict has incomplete component coverage');
  }
  const counts = record(verdict.counts, 'aggregate assurance counts');
  if (counts.PASS !== expectedComponents || counts.FAIL !== 0 || counts.BLOCKED !== 0) {
    throw new Error('aggregate assurance counts are not a complete PASS');
  }
  return verdict;
}

async function persistFinalReceipt(
  env: Bindings,
  repo: string,
  sha: string,
  admitted: Awaited<ReturnType<typeof admitFireCrabAssurancePlan>>,
  nativeKey: string,
  aggregate: JsonRecord,
): Promise<string> {
  const key = finalReceiptKey(repo, sha, admitted.planDigest);
  const receipt = {
    schemaVersion: 1,
    profile: 'firecrab-release-assurance-v1',
    repo,
    sha,
    verdict: 'PASS',
    planDigest: admitted.planDigest,
    policy: { id: admitted.policyId, digest: admitted.policyDigest },
    nativeReceipt: nativeKey,
    aggregate,
  };
  const text = JSON.stringify(receipt, null, 2) + '\n';
  const existing = await env.BACKUP_BUCKET.get(key);
  if (existing !== null) {
    if ((await existing.text()) !== text) {
      throw new Error('final assurance receipt collision for admitted plan');
    }
    return key;
  }
  await env.BACKUP_BUCKET.put(key, text, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      repo,
      sha,
      planDigest: admitted.planDigest,
      policyId: admitted.policyId,
      policyDigest: admitted.policyDigest,
      verdict: 'PASS',
    },
  });
  return key;
}

export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(
    event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const { repo, sha, ref } = event.payload;
    if (!GIT_OBJECT_ID.test(sha)) {
      throw new Error(`invalid source object id: ${sha}`);
    }

    const source = await ci.runner({
      name: 'verify-source',
      command:
        'test "$(git rev-parse HEAD)" = "$GITFLARE_EXPECTED_SHA" && git fsck --no-reflogs --connectivity-only',
      env: { GITFLARE_EXPECTED_SHA: sha },
    });

    if (repo === 'firecrab') {
      const sourceRef = normalizedRef(ref);
      const preflight = await source.runner({
        name: 'release-compliance-preflight',
        command: 'bash scripts/gitflare-release-compliance.sh',
        env: { GITFLARE_EXPECTED_SHA: sha },
        config: {
          timeout: PREFLIGHT_STEP_TIMEOUT_MS,
          commandTimeoutMs: PREFLIGHT_COMMAND_TIMEOUT_MS,
        },
      });

      const planOutput = await preflight.runner({
        name: 'read-assurance-plan',
        command: 'cat dist/gitflare-receipts/assurance-plan.json',
        env: { GITFLARE_EXPECTED_SHA: sha },
      });
      const planText = await readBoundedLog(planOutput.logs.stdout);
      const admitted = await step.do(
        'persist external assurance admission',
        async () => persistAdmittedPlan(this.env, repo, sha, planText),
      );

      const sourceIdentity: AssuranceSourceIdentity = {
        provider: 'cloudflare-artifacts',
        namespace: 'gitflare',
        repo,
        sha: sha.toLowerCase(),
        ref: sourceRef,
      };
      const workspaceId = assuranceWorkspaceId(repo, sha);
      const nativeJobs = nativeDispatchJobs(admitted, sourceIdentity);
      const dispatched: DispatchedNativeJob[] = [];

      for (const job of nativeJobs) {
        dispatched.push(await step.do(
          `dispatch ${job.jobId}`,
          { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
          async () => dispatchNativeJob(this.env.SCUMM_SHELL, workspaceId, job),
        ));
      }

      let statuses: Array<{ jobId: string; status: JsonRecord }> = [];
      let timedOut = true;
      for (let round = 1; round <= NATIVE_POLL_ROUNDS; round += 1) {
        statuses = await step.do(
          `poll native assurance ${round}`,
          { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
          async () => Promise.all(dispatched.map(async (job) => ({
            jobId: job.jobId,
            status: await readNativeJobStatus(this.env.SCUMM_SHELL, job),
          }))),
        );
        if (statuses.every(({ status }) => nativeStatusTerminal(status))) {
          timedOut = false;
          break;
        }
        await step.sleep(`wait native assurance ${round}`, NATIVE_POLL_DELAY);
      }

      const logs = await step.do(
        'collect native assurance logs',
        { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
        async () => Promise.all(dispatched.map(async (job) => {
          try {
            return { jobId: job.jobId, log: await readNativeJobLog(this.env.SCUMM_SHELL, job) };
          } catch (error) {
            return {
              jobId: job.jobId,
              log: { evidenceError: error instanceof Error ? error.message : String(error) },
            };
          }
        })),
      );

      const nativeKey = await step.do(
        'persist native assurance receipt',
        async () => persistNativeReceipt(
          this.env,
          repo,
          sha,
          admitted.planDigest,
          dispatched,
          statuses,
          logs,
          timedOut,
        ),
      );

      if (timedOut) {
        throw new Error(`native assurance timed out; receipt=${nativeKey}`);
      }
      const failures = statuses.filter(({ status }) => !nativeStatusSucceeded(status));
      if (failures.length > 0) {
        throw new Error(
          `native assurance failed for ${failures.map(({ jobId }) => jobId).join(', ')}; receipt=${nativeKey}`,
        );
      }

      const evidence = nativeEvidenceBundle(dispatched, logs);
      const materialized = await preflight.runner({
        name: 'materialize-native-evidence',
        command: MATERIALIZE_NATIVE_EVIDENCE,
        env: {
          GITFLARE_EXPECTED_SHA: sha,
          GITFLARE_NATIVE_EVIDENCE_B64: Buffer.from(JSON.stringify(evidence), 'utf8').toString('base64'),
        },
      });
      const aggregate = await materialized.runner({
        name: 'aggregate',
        command: AGGREGATE_COMMAND,
        env: { GITFLARE_EXPECTED_SHA: sha },
      });
      const aggregateOutput = await aggregate.runner({
        name: 'read-aggregate-verdict',
        command: 'cat dist/assurance/verdict.json',
        env: { GITFLARE_EXPECTED_SHA: sha },
      });
      const aggregateText = await readBoundedLog(aggregateOutput.logs.stdout);
      let aggregateValue: unknown;
      try {
        aggregateValue = JSON.parse(aggregateText);
      } catch {
        throw new Error('aggregate assurance verdict is invalid JSON');
      }
      const aggregateVerdict = validateAggregateVerdict(
        aggregateValue,
        sha.toLowerCase(),
        1 + dispatched.length,
      );
      await step.do(
        'persist final assurance receipt',
        async () => persistFinalReceipt(
          this.env,
          repo,
          sha,
          admitted,
          nativeKey,
          aggregateVerdict,
        ),
      );
    }
  }
}
