import { CIWorkflow } from '@cloudflare/ci';
import type { CiContext, CiParams, CloudflareArtifacts } from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Bindings } from './env';

const GIT_OBJECT_ID = /^[a-f0-9]{40}([a-f0-9]{24})?$/i;

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
      await source.runner({
        name: 'release-compliance-preflight',
        command: 'bash scripts/gitflare-release-compliance.sh',
        env: { GITFLARE_EXPECTED_SHA: sha },
      });
    }
  }
}
