import type { CiBindings } from '@cloudflare/ci/worker';

export type Bindings = CiBindings &
  CloudflareBindings & {
    GITFLARE_CI_MCP_HOST: string;
    GITFLARE_CI_MCP_TOKEN: string;
  };
