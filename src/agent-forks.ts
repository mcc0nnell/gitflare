/** Cloudflare Artifacts agent fork provisioning. Admin authorization is enforced by the Worker caller. */
export interface AgentForkResult {
  source: string;
  fork: string;
  remote: string;
  defaultBranch: string | null;
  initialToken: unknown | null;
  note: string;
}
interface ForkResult { name: string; remote: string; defaultBranch?: string; token?: unknown; }
interface ForkHandle {
  fork(name: string, opts: { description: string; defaultBranchOnly: boolean; readOnly: boolean }): Promise<ForkResult>;
  [Symbol.dispose]?: () => void;
}
interface ForkBinding { get(name: string): Promise<ForkHandle>; }
const REPO = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;

export async function provisionAgentFork(
  artifacts: ForkBinding, sourceName: string, label = 'isolated agent workspace',
): Promise<AgentForkResult> {
  if (!REPO.test(sourceName)) throw new Error('Invalid Artifacts repository name');
  if (typeof label !== 'string' || label.length > 100 || /[\r\n\x00-\x1f]/.test(label)) {
    throw new Error('Invalid agent task label');
  }
  const forkName = sourceName.slice(0, 60) + '-agent-' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const source = await artifacts.get(sourceName);
  try {
    const result = await source.fork(forkName, {
      description: 'Gitflare agent fork: ' + label,
      defaultBranchOnly: true,
      readOnly: false,
    });
    return {
      source: sourceName, fork: result.name, remote: result.remote,
      defaultBranch: result.defaultBranch ?? null, initialToken: result.token ?? null,
      note: 'Fork created. Not merged or approved. Read fork HEAD after clone and track its immutable commit SHA.',
    };
  } finally { source[Symbol.dispose]?.(); }
}
