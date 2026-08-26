export const GITFLARE_INTERNAL_CONTROL_HOST = 'gitflare.internal';

export function internalControlAuthorized(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === 'https:' && url.hostname === GITFLARE_INTERNAL_CONTROL_HOST;
}
