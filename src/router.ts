import legacy from './index.js';
import { handleExecutionHandoff, type HandoffEnv } from './execution-handoff.js';

type LegacyEnv = Parameters<typeof legacy.fetch>[1];
type Env = LegacyEnv & HandoffEnv;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/repos\/([^/]+)\/execution-handoffs$/.exec(url.pathname);
    if (request.method === 'POST' && match) {
      return handleExecutionHandoff(request, env, match[1]);
    }
    return legacy.fetch(request, env);
  },
};
