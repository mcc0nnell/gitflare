import { CIWorkflow, isCiRunnerFailure } from '@cloudflare/ci';
import type { CiContext, CiParams, CloudflareArtifacts } from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Bindings } from './env';

function emitCiReceipt(
  level: 'info' | 'error',
  eventName: string,
  event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  const p = event.payload;
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: 'gitflare-artifacts-ci',
    source_plane: 'cloudflare-artifacts',
    event: eventName,
    workflow_instance_id: event.instanceId,
    provider: p.provider,
    repo: p.repo,
    sha: p.sha,
    ref: p.ref,
    trigger: p.trigger,
    ...fields,
  });

  if (level === 'error') {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(
    event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    emitCiReceipt('info', 'ci.pipeline.started', event);

    try {
      const result = await ci.runner({
        name: 'verify-source',
        command: 'git rev-parse HEAD && git fsck --no-reflogs --connectivity-only',
      });

      emitCiReceipt('info', 'ci.runner.completed', event, {
        runner: 'verify-source',
        exit_code: result.exitCode,
      });
      emitCiReceipt('info', 'ci.pipeline.completed', event);
    } catch (error) {
      if (isCiRunnerFailure(error)) {
        emitCiReceipt('error', 'ci.runner.failed', event, {
          runner: error.runner.name,
          failure_count: error.diagnostics.failures.length,
        });
      } else {
        emitCiReceipt('error', 'ci.pipeline.failed', event, {
          error_type: error instanceof Error ? error.name : typeof error,
        });
      }
      throw error;
    }
  }
}
