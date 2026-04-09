import pc from 'picocolors';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLES_REPO = { owner: 'skills-il', repo: 'bundles' };

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

export async function runAddBundle(args: string[]): Promise<void> {
  const slug = args[0];
  const dryRun = args.includes('--dry-run');
  const passthrough = args.filter(a => a !== slug && a !== '--dry-run');

  if (!slug) {
    console.log(pc.red('Usage: npx skills-il add-bundle <bundle-slug>'));
    console.log();
    console.log(pc.dim('List available bundles:'));
    console.log('  $ npx skills-il bundles');
    return;
  }

  console.log(pc.dim(`Fetching bundle "${slug}"...`));

  // Fetch bundle.json
  let bundleJson: BundleJson;
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${BUNDLES_REPO.owner}/${BUNDLES_REPO.repo}/master/${slug}/bundle.json`,
      { headers: { 'User-Agent': 'skills-il-cli' } }
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

    bundleJson = await res.json() as BundleJson;
  } catch (err) {
    console.log(pc.red(`Error fetching bundle: ${err instanceof Error ? err.message : 'Unknown error'}`));
    return;
  }

  const icon = '📦';
  const skills = bundleJson.skills || [];

  console.log();
  console.log(`${icon} ${pc.bold(bundleJson.name_en)} ${pc.dim(`- ${skills.length} skills`)}`);
  if (bundleJson.description_en) {
    console.log(`  ${pc.dim(bundleJson.description_en)}`);
  }
  console.log();

  if (skills.length === 0) {
    console.log(pc.dim('Bundle has no skills.'));
    return;
  }

  if (dryRun) {
    console.log(pc.dim('Dry run - would install:'));
    for (const skill of skills) {
      console.log(`  ${pc.dim('•')} ${skill.slug} ${pc.dim(`(${skill.repo})`)}`);
    }
    return;
  }

  // Find the CLI entry point for spawning add commands
  const cliEntry = join(__dirname, '..', 'bin', 'cli.mjs');
  const cliExists = existsSync(cliEntry);

  let successCount = 0;
  let failCount = 0;
  const failures: string[] = [];

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    const progress = `[${i + 1}/${skills.length}]`;

    // Build the GitHub URL for this skill: https://github.com/owner/repo/tree/master/path
    const installUrl = `https://github.com/${skill.repo}/tree/master/${skill.path}`;

    console.log(`${pc.dim(progress)} Installing ${pc.bold(skill.slug)}...`);

    if (cliExists) {
      // Use the compiled CLI entry point
      const result = spawnSync(
        process.execPath,
        [cliEntry, 'add', installUrl, '-g', '-y', ...passthrough],
        {
          stdio: ['inherit', 'pipe', 'pipe'],
          encoding: 'utf-8',
          shell: process.platform === 'win32',
        }
      );

      if (result.status === 0) {
        successCount++;
        console.log(`  ${pc.green('✓')} ${skill.slug}`);
      } else {
        failCount++;
        failures.push(skill.slug);
        console.log(`  ${pc.red('✗')} ${skill.slug}`);
        if (result.stderr) {
          const errLine = result.stderr.trim().split('\n')[0];
          if (errLine) console.log(`    ${pc.dim(errLine)}`);
        }
      }
    } else {
      // Fallback: use npx to run the CLI (slower but works for dev)
      const result = spawnSync(
        'npx',
        ['skills-il', 'add', installUrl, '-g', '-y', ...passthrough],
        {
          stdio: ['inherit', 'pipe', 'pipe'],
          encoding: 'utf-8',
          shell: true,
        }
      );

      if (result.status === 0) {
        successCount++;
        console.log(`  ${pc.green('✓')} ${skill.slug}`);
      } else {
        failCount++;
        failures.push(skill.slug);
        console.log(`  ${pc.red('✗')} ${skill.slug}`);
      }
    }
  }

  console.log();
  if (successCount > 0) {
    console.log(`${pc.green('✓')} Bundle "${bundleJson.name_en}" installed (${successCount}/${skills.length} skills)`);
  }
  if (failCount > 0) {
    console.log(`${pc.red('✗')} Failed: ${failures.join(', ')}`);
    console.log(pc.dim('You can install failed skills individually with: npx skills-il add <url>'));
  }
  console.log();
}
