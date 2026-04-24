import pc from 'picocolors';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline/promises';
import { getGitHubToken } from './skill-lock.ts';

const DESIGN_REPO = { owner: 'skills-il', repo: 'design-systems' };
const DESIGN_API_BASE = 'https://agentskills.co.il';

const SLUG_RE = /^[a-z0-9-]+$/;
const AGENT_RE = /^[a-z0-9-]+$/;

function parseArgs(args: string[]): { slug: string | undefined; agent: string | null } {
  let agent: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-a' || a === '--agent') {
      const next = args[i + 1];
      if (next && AGENT_RE.test(next)) agent = next;
      i++;
      continue;
    }
    if (a === '-y' || a === '--yes') continue;
    if (a && !a.startsWith('-')) positional.push(a);
  }
  return { slug: positional[0], agent };
}

export async function runUpdateDesign(args: string[]): Promise<void> {
  const { slug, agent } = parseArgs(args);
  const force = args.includes('-y') || args.includes('--yes');

  if (!slug) {
    console.log(pc.red('Usage: npx skills-il update-design <design-slug>'));
    return;
  }

  if (!SLUG_RE.test(slug)) {
    console.log(pc.red(`Invalid slug "${slug}".`));
    return;
  }

  const targetPath = join(process.cwd(), 'DESIGN.md');
  if (!existsSync(targetPath)) {
    console.log(pc.red('No DESIGN.md in the current directory.'));
    console.log(pc.dim(`Run ${pc.bold('npx skills-il add-design ' + slug)} to install it first.`));
    return;
  }

  console.log(pc.dim(`Checking "${slug}" for updates...`));

  const remote = await fetchDesignMd(slug);
  if (remote == null) return;

  const local = readFileSync(targetPath, 'utf-8');
  if (local === remote) {
    console.log(pc.green('✓ DESIGN.md is up to date.'));
    return;
  }

  const remoteLines = remote.split('\n').length;
  const localLines = local.split('\n').length;
  console.log(pc.dim(`Local: ${localLines} lines · Remote: ${remoteLines} lines`));

  if (!force) {
    const overwrite = await prompt(`Overwrite local DESIGN.md with the latest version? [y/N] `);
    if (overwrite !== 'y' && overwrite !== 'yes') {
      console.log(pc.dim('Cancelled.'));
      return;
    }
  }

  writeFileSync(targetPath, remote, 'utf-8');
  trackInstall(slug, agent);

  console.log();
  console.log(pc.green(`✓ Updated DESIGN.md`));
}

async function fetchDesignMd(slug: string): Promise<string | null> {
  const token = getGitHubToken();
  const headers: Record<string, string> = { 'User-Agent': 'skills-il-cli' };
  if (token) headers['Authorization'] = `token ${token}`;

  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${DESIGN_REPO.owner}/${DESIGN_REPO.repo}/master/systems/${slug}/DESIGN.md`,
      { headers }
    );

    if (res.status === 404) {
      console.log(pc.red(`Design system "${slug}" not found on remote.`));
      return null;
    }
    if (!res.ok) {
      console.log(pc.red(`Failed to fetch DESIGN.md: HTTP ${res.status}`));
      return null;
    }
    return await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.log(pc.red(`Error fetching design system: ${msg}`));
    return null;
  }
}

function trackInstall(slug: string, agent: string | null): void {
  const tool = agent ?? 'cli';
  fetch(`${DESIGN_API_BASE}/api/design/${encodeURIComponent(slug)}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'skills-il-cli' },
    body: JSON.stringify({ tool }),
  }).catch(() => {
    /* silent */
  });
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase();
  } finally {
    rl.close();
  }
}
