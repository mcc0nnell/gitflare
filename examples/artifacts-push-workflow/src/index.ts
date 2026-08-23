import { CiSandbox } from '@cloudflare/ci/worker';

export { CiSandbox };
export { CI } from '../cloudflare.ci';

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return Response.json({
        ok: true,
        service: 'gitflare-artifacts-ci',
        trigger: 'cf.artifacts.repo.pushed',
        namespace: 'gitflare',
      });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};
