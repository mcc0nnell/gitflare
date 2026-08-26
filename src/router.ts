import legacy from './index.js';
import { handleExecutionHandoff, type HandoffEnv } from './execution-handoff.js';
import {
  handleEvidenceDownload,
  handleEvidenceHandoff,
  handleEvidenceManifest,
  handleEvidenceUpload,
  type EvidenceEnv,
} from './evidence.js';
import { handleSourceBootstrap, type SourceBootstrapEnv } from './source-bootstrap.js';

type LegacyEnv = Parameters<typeof legacy.fetch>[1];
type Env = LegacyEnv & HandoffEnv & EvidenceEnv & SourceBootstrapEnv;

const INTERNAL_HOST = 'gitflare.internal';
const PUBLIC_EVIDENCE_HOST = 'evidence.scumm.app';

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === PUBLIC_EVIDENCE_HOST) {
      const upload = /^\/evidence\/uploads\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'PUT' && upload) {
        return handleEvidenceUpload(request, env, upload[1], upload[2]);
      }
      return notFound();
    }

    if (url.hostname !== INTERNAL_HOST) return notFound();

    const bootstrap = /^\/repos\/([^/]+)\/bootstrap$/.exec(url.pathname);
    if (request.method === 'POST' && bootstrap) {
      return handleSourceBootstrap(request, env, bootstrap[1]);
    }

    const execution = /^\/repos\/([^/]+)\/execution-handoffs$/.exec(url.pathname);
    if (request.method === 'POST' && execution) {
      return handleExecutionHandoff(request, env, execution[1]);
    }

    const evidenceHandoff = /^\/repos\/([^/]+)\/evidence-handoffs$/.exec(url.pathname);
    if (request.method === 'POST' && evidenceHandoff) {
      return handleEvidenceHandoff(request, env, evidenceHandoff[1]);
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
