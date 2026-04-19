import { execFile } from 'child_process';
import { promisify } from 'util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { AddOptions } from './add.ts';

const execFileAsync = promisify(execFile);

/**
 * Opt-in delegation to GitHub's `gh skill` CLI.
 *
 * GitHub shipped `gh skill install` in April 2026 with Sigstore attestation
 * verification and content-addressed updates. Users who want that experience
 * pass `--via-gh` to route installs through it. When `gh` is missing or
 * not authenticated, we fall back to the native install flow.
 *
 * Detection is conservative: this never hijacks the flow silently.
 */
export async function isGhSkillAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('gh', ['skill', '--help'], { timeout: 5000 });
    return stdout.includes('install');
  } catch {
    return false;
  }
}

/**
 * Delegates to `gh skill install <owner>/<repo> <skill> --agent <agent>`.
 *
 * Caller is responsible for verifying gh is available (see isGhSkillAvailable)
 * and for choosing when to delegate (typically when options.viaGh is true and
 * the source parses to a concrete owner/repo).
 *
 * Returns true on success, false when delegation failed (caller can fall back).
 */
export async function delegateToGhSkill(
  source: string,
  options: AddOptions & { viaGh?: boolean }
): Promise<boolean> {
  // Best-effort parse of source into owner/repo
  // Supports formats: "owner/repo", "owner/repo --skill <name>", github URLs
  const m = source.match(/^([\w.-]+\/[\w.-]+)$/);
  if (!m || !m[1]) {
    p.log.warn('--via-gh only supports `owner/repo` sources; falling back to native flow.');
    return false;
  }
  const ownerRepo: string = m[1];

  const skills = options.skill ?? [];
  if (skills.length === 0) {
    p.log.warn('--via-gh requires --skill <name>; falling back to native flow.');
    return false;
  }

  const agents = options.agent ?? [];

  let allOk = true;
  for (const skill of skills) {
    for (const agent of agents.length > 0 ? agents : ['claude-code']) {
      const args = ['skill', 'install', ownerRepo, skill, '--agent', agent];
      p.log.info(pc.dim(`$ gh ${args.join(' ')}`));
      try {
        const { stdout, stderr } = await execFileAsync('gh', args, { timeout: 120_000 });
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
      } catch (err) {
        allOk = false;
        const msg = err instanceof Error ? err.message : String(err);
        p.log.error(`gh skill install failed for ${skill}/${agent}: ${msg}`);
      }
    }
  }
  return allOk;
}
