import { CiSandbox } from '@cloudflare/ci/worker';
import type { Bindings } from '../env';
import { handleCiMcpRequest } from './mcp';

export { CiSandbox };
export { CI } from '../cloudflare.ci';

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/mcp') {
      return handleCiMcpRequest(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return Response.json({
        ok: true,
        service: 'gitflare-artifacts-ci',
        trigger: 'cf.artifacts.repo.pushed',
        namespace: 'gitflare',
        mcp: '/mcp',
      });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};
