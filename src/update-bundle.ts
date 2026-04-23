import pc from 'picocolors';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { fetchSkillFolderHash, getGitHubToken } from './skill-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLES_REPO = { owner: 'skills-il', repo: 'bundles' };

const AGENTS_DIR = '.agents';
const LOCK_FILE = '.skill-lock.json';
const CURRENT_LOCK_VERSION = 3;

// Validate bundle.json fields before interpolating into URLs / spawn args.
// bundle.json is fetched from a network source; a malformed or malicious entry
// could inject path segments ("..") or arbitrary repo coordinates.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const PATH_RE = /^[\w./-]+$/;
const SLUG_RE = /^[\w.-]+$/;

interface BundleSkill {
  slug: string;
  repo: string;
  path: string;
}

interface BundleJson {
  name_en: string;
  name_he: string;
  description_en?: string;
  skills: BundleSkill[];
}

interface SkillLockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath?: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
}

interface SkillLockFile {
  version: number;
  skills: Record<string, SkillLockEntry>;
}

function getSkillLockPath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) {
    return join(xdgStateHome, 'skills', LOCK_FILE);
  }
  return join(homedir(), AGENTS_DIR, LOCK_FILE);
}

function readSkillLock(): SkillLockFile {
  try {
    const content = readFileSync(getSkillLockPath(), 'utf-8');
    const parsed = JSON.parse(content) as SkillLockFile;
    if (typeof parsed.version !== 'number' || !parsed.skills) {
      return { version: CURRENT_LOCK_VERSION, skills: {} };
    }
    // Old format lock files lack skillFolderHash; wipe to force fresh installs
    // (matches the behavior in cli.ts and skill-lock.ts).
    if (parsed.version < CURRENT_LOCK_VERSION) {
      return { version: CURRENT_LOCK_VERSION, skills: {} };
    }
    return parsed;
  } catch {
    return { version: CURRENT_LOCK_VERSION, skills: {} };
  }
}

function isValidBundleSkill(s: unknown): s is BundleSkill {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.slug === 'string' &&
    SLUG_RE.test(o.slug) &&
    typeof o.repo === 'string' &&
    REPO_RE.test(o.repo) &&
    typeof o.path === 'string' &&
    PATH_RE.test(o.path) &&
    !o.path.includes('..')
  );
}

// Strip `SKILL.md` off a lock-file path. `bundle.json` records the skill as a
// folder path (e.g. `hebrew-date`), while the lock records `hebrew-date/SKILL.md`
// — so we normalize the lock side to match bundle-side for comparison.
function skillFolderFromPath(skillPath: string | undefined): string {
  if (!skillPath) return '';
  let folder = skillPath;
  if (folder.endsWith('/SKILL.md')) folder = folder.slice(0, -9);
  else if (folder.endsWith('SKILL.md')) folder = folder.slice(0, -8);
  if (folder.endsWith('/')) folder = folder.slice(0, -1);
  return folder;
}

// Detect a repo's default branch via the GitHub API. Cached per `owner/repo`
// so a bundle with N skills across M repos costs at most M requests.
// Falls back to 'master' (the skills-il convention) on any API failure.
const defaultBranchCache = new Map<string, string>();
async function getDefaultBranch(repo: string, token: string | null): Promise<string> {
  const cached = defaultBranchCache.get(repo);
  if (cached) return cached;
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'skills-il-cli',
    };
    if (token) headers['Authorization'] = `token ${token}`;
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (res.ok) {
      const data = (await res.json()) as { default_branch?: string };
      if (data.default_branch) {
        defaultBranchCache.set(repo, data.default_branch);
        return data.default_branch;
      }
    }
  } catch {
    // fall through to default
  }
  defaultBranchCache.set(repo, 'master');
  return 'master';
}

function findInstalledEntry(
  lock: SkillLockFile,
  skill: BundleSkill
): { name: string; entry: SkillLockEntry } | null {
  for (const [name, entry] of Object.entries(lock.skills)) {
    if (entry.source !== skill.repo) continue;
    const folder = skillFolderFromPath(entry.skillPath);
    if (folder === skill.path) {
      return { name, entry };
    }
  }
  return null;
}

export async function runUpdateBundle(args: string[]): Promise<void> {
  // The bundle slug is the first non-flag argument. Letting it float past
  // leading flags means `update-bundle --agent cursor my-slug` works the same
  // as `update-bundle my-slug --agent cursor`.
  const slug = args.find((a) => !a.startsWith('-'));
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force') || args.includes('-f');
  const passthrough = args.filter(
    (a) => a !== slug && a !== '--dry-run' && a !== '--force' && a !== '-f'
  );

  if (!slug) {
    console.log(pc.red('Usage: npx skills-il update-bundle <bundle-slug> [--dry-run] [--force]'));
    console.log();
    console.log(pc.dim('List available bundles:'));
    console.log('  $ npx skills-il bundles');
    return;
  }

  console.log(pc.dim(`Fetching bundle "${slug}"...`));

  const token = getGitHubToken();
  let bundleJson: BundleJson;
  try {
    const fetchHeaders: Record<string, string> = { 'User-Agent': 'skills-il-cli' };
    if (token) fetchHeaders['Authorization'] = `token ${token}`;
    const res = await fetch(
      `https://raw.githubusercontent.com/${BUNDLES_REPO.owner}/${BUNDLES_REPO.repo}/master/${slug}/bundle.json`,
      { headers: fetchHeaders }
    );

    if (!res.ok) {
      if (res.status === 404) {
        console.log(pc.red(`Bundle "${slug}" not found.`));
        console.log(pc.dim('Run `npx skills-il bundles` to see available bundles.'));
      } else {
        console.log(pc.red(`Failed to fetch bundle: ${res.status}`));
      }
      return;
    }

    bundleJson = (await res.json()) as BundleJson;
  } catch (err) {
    console.log(
      pc.red(`Error fetching bundle: ${err instanceof Error ? err.message : 'Unknown error'}`)
    );
    return;
  }

  const icon = '📦';
  const rawSkills = Array.isArray(bundleJson.skills) ? bundleJson.skills : [];
  const skills: BundleSkill[] = [];
  const malformed: unknown[] = [];
  for (const entry of rawSkills) {
    if (isValidBundleSkill(entry)) {
      skills.push(entry);
    } else {
      malformed.push(entry);
    }
  }

  console.log();
  console.log(`${icon} ${pc.bold(bundleJson.name_en)} ${pc.dim(`- ${skills.length} skills`)}`);
  if (bundleJson.description_en) {
    console.log(`  ${pc.dim(bundleJson.description_en)}`);
  }
  console.log();

  if (malformed.length > 0) {
    console.log(
      pc.yellow(
        `! ${malformed.length} malformed skill entr${malformed.length === 1 ? 'y' : 'ies'} in bundle.json (skipped)`
      )
    );
    console.log();
  }

  if (skills.length === 0) {
    console.log(pc.dim('Bundle has no valid skills.'));
    return;
  }

  // Diff against local lock file
  const lock = readSkillLock();

  const toAdd: BundleSkill[] = [];
  const toUpdate: Array<{ skill: BundleSkill; name: string; entry: SkillLockEntry }> = [];
  const upToDate: Array<{ skill: BundleSkill; name: string }> = [];
  const uncheckable: Array<{ skill: BundleSkill; name: string; reason: string }> = [];

  console.log(pc.dim('Checking which skills need updates...'));

  for (const skill of skills) {
    const installed = findInstalledEntry(lock, skill);

    if (!installed) {
      toAdd.push(skill);
      continue;
    }

    if (force) {
      toUpdate.push({ skill, name: installed.name, entry: installed.entry });
      continue;
    }

    if (!installed.entry.skillFolderHash || !installed.entry.skillPath) {
      uncheckable.push({
        skill,
        name: installed.name,
        reason: 'no hash recorded (reinstall to enable updates)',
      });
      continue;
    }

    try {
      const latestHash = await fetchSkillFolderHash(
        installed.entry.source,
        installed.entry.skillPath,
        token
      );
      if (!latestHash) {
        uncheckable.push({ skill, name: installed.name, reason: 'could not fetch from GitHub' });
      } else if (latestHash !== installed.entry.skillFolderHash) {
        toUpdate.push({ skill, name: installed.name, entry: installed.entry });
      } else {
        upToDate.push({ skill, name: installed.name });
      }
    } catch (err) {
      uncheckable.push({
        skill,
        name: installed.name,
        reason: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  // Summary
  console.log();
  console.log(`  ${pc.dim('up-to-date:')} ${upToDate.length}`);
  console.log(`  ${pc.dim('to add:    ')} ${toAdd.length}`);
  console.log(`  ${pc.dim('to update: ')} ${toUpdate.length}`);
  if (uncheckable.length > 0) {
    console.log(`  ${pc.dim('skipped:   ')} ${uncheckable.length}`);
  }
  console.log();

  if (toAdd.length === 0 && toUpdate.length === 0) {
    console.log(pc.green(`✓ Bundle "${bundleJson.name_en}" is up to date`));
    if (uncheckable.length > 0) {
      console.log();
      for (const u of uncheckable) {
        console.log(`  ${pc.yellow('!')} ${u.name} ${pc.dim(`(${u.reason})`)}`);
      }
    }
    console.log();
    return;
  }

  if (dryRun) {
    if (toAdd.length > 0) {
      console.log(pc.dim('Would add:'));
      for (const s of toAdd) {
        console.log(`  ${pc.green('+')} ${s.slug} ${pc.dim(`(${s.repo})`)}`);
      }
    }
    if (toUpdate.length > 0) {
      console.log(pc.dim('Would update:'));
      for (const u of toUpdate) {
        console.log(`  ${pc.cyan('↑')} ${u.name} ${pc.dim(`(${u.entry.source})`)}`);
      }
    }
    if (uncheckable.length > 0) {
      console.log(pc.dim('Would skip:'));
      for (const u of uncheckable) {
        console.log(`  ${pc.yellow('!')} ${u.name} ${pc.dim(`(${u.reason})`)}`);
      }
    }
    console.log();
    return;
  }

  // Execute add + update via the CLI entry point
  const cliEntry = join(__dirname, '..', 'bin', 'cli.mjs');
  const cliExists = existsSync(cliEntry);

  const work: Array<{ action: 'add' | 'update'; label: string; url: string }> = [];
  for (const s of toAdd) {
    const branch = await getDefaultBranch(s.repo, token);
    work.push({
      action: 'add',
      label: s.slug,
      url: `https://github.com/${s.repo}/tree/${branch}/${s.path}`,
    });
  }
  for (const u of toUpdate) {
    const branch = await getDefaultBranch(u.skill.repo, token);
    work.push({
      action: 'update',
      label: u.name,
      url: `https://github.com/${u.skill.repo}/tree/${branch}/${u.skill.path}`,
    });
  }

  let successCount = 0;
  let failCount = 0;
  const failures: string[] = [];

  for (let i = 0; i < work.length; i++) {
    const item = work[i]!;
    const progress = `[${i + 1}/${work.length}]`;
    const verb = item.action === 'add' ? 'Installing' : 'Updating';
    console.log(`${pc.dim(progress)} ${verb} ${pc.bold(item.label)}...`);

    const spawnArgs = ['add', item.url, '-g', '-y', ...passthrough];
    const result = cliExists
      ? spawnSync(process.execPath, [cliEntry, ...spawnArgs], {
          stdio: ['inherit', 'pipe', 'pipe'],
          encoding: 'utf-8',
          shell: process.platform === 'win32',
        })
      : spawnSync('npx', ['skills-il', ...spawnArgs], {
          stdio: ['inherit', 'pipe', 'pipe'],
          encoding: 'utf-8',
          shell: true,
        });

    if (result.status === 0) {
      successCount++;
      const mark = item.action === 'add' ? pc.green('+') : pc.cyan('↑');
      console.log(`  ${mark} ${item.label}`);
    } else {
      failCount++;
      failures.push(item.label);
      console.log(`  ${pc.red('✗')} ${item.label}`);
      if (result.stderr) {
        const errLine = result.stderr.trim().split('\n')[0];
        if (errLine) console.log(`    ${pc.dim(errLine)}`);
      }
    }
  }

  console.log();
  if (successCount > 0) {
    console.log(
      `${pc.green('✓')} Bundle "${bundleJson.name_en}" updated (${successCount}/${work.length} skills)`
    );
  }
  if (failCount > 0) {
    console.log(`${pc.red('✗')} Failed: ${failures.join(', ')}`);
    console.log(pc.dim('You can retry individually with: npx skills-il add <url>'));
  }
  if (uncheckable.length > 0) {
    console.log();
    console.log(pc.dim(`${uncheckable.length} skill(s) skipped (cannot check automatically):`));
    for (const u of uncheckable) {
      console.log(`  ${pc.yellow('!')} ${u.name} ${pc.dim(`(${u.reason})`)}`);
    }
  }
  console.log();
}
