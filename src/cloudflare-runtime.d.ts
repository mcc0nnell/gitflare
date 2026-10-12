declare module 'cloudflare:workers' {
  export abstract class DurableObject {
    constructor(ctx: unknown, env: unknown);
    fetch(request: Request): Response | Promise<Response>;
  }
}
