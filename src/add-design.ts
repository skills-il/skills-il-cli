import pc from 'picocolors';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline/promises';
import { getGitHubToken } from './skill-lock.ts';

const DESIGN_REPO = { owner: 'skills-il', repo: 'design-systems' };
const DESIGN_API_BASE = 'https://agentskills.co.il';

const SLUG_RE = /^[a-z0-9-]+$/;
const AGENT_RE = /^[a-z0-9-]+$/;

/** Pull `-a <agent>` / `--agent <agent>` out of the arg list, return both
 *  the agent (or null) and the slug (first non-flag positional). */
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

export async function runAddDesign(args: string[]): Promise<void> {
  const { slug, agent } = parseArgs(args);
  const force = args.includes('-y') || args.includes('--yes');

  if (!slug) {
    console.log(pc.red('Usage: npx skills-il add-design <design-slug>'));
    console.log();
    console.log(pc.dim('Example:'));
    console.log('  $ npx skills-il add-design baniyan');
    return;
  }

  if (!SLUG_RE.test(slug)) {
    console.log(pc.red(`Invalid slug "${slug}". Use lowercase letters, digits, and dashes.`));
    return;
  }

  console.log(pc.dim(`Fetching design system "${slug}"...`));

  const source = await fetchDesignMd(slug);
  if (source == null) return;

  const targetPath = join(process.cwd(), 'DESIGN.md');

  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath, 'utf-8');
    if (existing === source) {
      console.log(pc.green(`✓ DESIGN.md is already at the latest version for "${slug}".`));
      return;
    }
    if (!force) {
      const overwrite = await prompt(
        `DESIGN.md already exists at ${targetPath}. Overwrite? [y/N] `
      );
      if (overwrite !== 'y' && overwrite !== 'yes') {
        console.log(pc.dim('Cancelled.'));
        return;
      }
    }
  }

  writeFileSync(targetPath, source, 'utf-8');
  trackInstall(slug, agent);

  console.log();
  console.log(pc.green(`✓ Wrote DESIGN.md`));
  console.log(pc.dim('Point your coding agent at this file so it follows the design system.'));
  console.log();
  console.log(pc.dim('Next:'));
  console.log(
    `  $ ${pc.bold('npx skills-il update-design ' + slug)} ${pc.dim('to refresh later')}`
  );
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
      console.log(pc.red(`Design system "${slug}" not found.`));
      console.log(pc.dim('Browse available systems at https://agentskills.co.il/design'));
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

/**
 * Fire-and-forget install tracking. POSTs `{tool}` to the design install
 * endpoint so `design_systems.installs_by_tool` records per-agent buckets
 * (`{claude-code: n, cursor: n, cli: n, ...}`). When the user passes
 * `-a <agent>`, that agent name is the tool key; otherwise we fall back
 * to the generic `cli` bucket.
 */
function trackInstall(slug: string, agent: string | null): void {
  const tool = agent ?? 'cli';
  fetch(`${DESIGN_API_BASE}/api/design/${encodeURIComponent(slug)}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'skills-il-cli' },
    body: JSON.stringify({ tool }),
  }).catch(() => {
    // Silent: telemetry must never block a working install.
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
