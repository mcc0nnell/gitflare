import legacy from './index.js';
import { handleExecutionHandoff, type HandoffEnv } from './execution-handoff.js';
import {
  handleEvidenceDownload,
  handleEvidenceHandoff,
  handleEvidenceManifest,
  handleEvidenceUpload,
  type EvidenceEnv,
} from './evidence.js';

type LegacyEnv = Parameters<typeof legacy.fetch>[1];
type Env = LegacyEnv & HandoffEnv & EvidenceEnv;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const execution = /^\/repos\/([^/]+)\/execution-handoffs$/.exec(url.pathname);
    if (request.method === 'POST' && execution) {
      return handleExecutionHandoff(request, env, execution[1]);
    }

    const evidenceHandoff = /^\/repos\/([^/]+)\/evidence-handoffs$/.exec(url.pathname);
    if (request.method === 'POST' && evidenceHandoff) {
      return handleEvidenceHandoff(request, env, evidenceHandoff[1]);
    }

    const upload = /^\/evidence\/uploads\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'PUT' && upload) {
      return handleEvidenceUpload(request, env, upload[1], upload[2]);
    }

    const artifact = /^\/evidence\/runs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && artifact) {
      return handleEvidenceDownload(request, env, artifact[1], artifact[2]);
    }

    const manifest = /^\/evidence\/runs\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && manifest) {
      return handleEvidenceManifest(request, env, manifest[1]);
    }

    return legacy.fetch(request, env);
  },
};
