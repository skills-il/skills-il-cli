import pc from 'picocolors';
import { getGitHubToken } from './skill-lock.ts';

const BUNDLES_REPO = { owner: 'skills-il', repo: 'bundles' };

interface BundleJson {
  name_en: string;
  name_he: string;
  description_en?: string;
  description_he?: string;
  icon?: string;
  skills: Array<{ slug: string }>;
}

export async function runBundles(): Promise<void> {
  console.log(pc.dim('Fetching available bundles...'));
  console.log();

  try {
    const token = getGitHubToken();
    const ghHeaders: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'skills-il-cli',
    };
    if (token) ghHeaders['Authorization'] = `token ${token}`;

    // Fetch directory listing from GitHub API
    const res = await fetch(
      `https://api.github.com/repos/${BUNDLES_REPO.owner}/${BUNDLES_REPO.repo}/contents?ref=master`,
      { headers: ghHeaders }
    );

    if (!res.ok) {
      console.log(pc.red(`Failed to fetch bundles: ${res.status}`));
      return;
    }

    const items = (await res.json()) as Array<{ name: string; type: string }>;
    const dirs = items.filter((i) => i.type === 'dir');

    if (dirs.length === 0) {
      console.log(pc.dim('No bundles available yet.'));
      return;
    }

    // Fetch bundle.json for each directory in parallel
    const results = await Promise.allSettled(
      dirs.map(async (dir) => {
        const jsonRes = await fetch(
          `https://raw.githubusercontent.com/${BUNDLES_REPO.owner}/${BUNDLES_REPO.repo}/master/${dir.name}/bundle.json`,
          { headers: { 'User-Agent': 'skills-il-cli' } }
        );
        if (!jsonRes.ok) return null;
        const data = (await jsonRes.json()) as BundleJson;
        return { slug: dir.name, data };
      })
    );
    const bundles = results
      .filter(
        (r): r is PromiseFulfilledResult<{ slug: string; data: BundleJson } | null> =>
          r.status === 'fulfilled'
      )
      .map((r) => r.value)
      .filter((b): b is { slug: string; data: BundleJson } => b !== null);

    console.log(pc.bold(`📦 Available bundles (${bundles.length}):`));
    console.log();

    for (const { slug, data } of bundles) {
      const icon = data.icon || '📦';
      const skillCount = data.skills?.length || 0;
      console.log(`  ${icon} ${pc.bold(data.name_en)} ${pc.dim(`(${slug})`)}`);
      console.log(`     ${pc.dim(data.description_en || '')}`);
      console.log(`     ${pc.dim(`${skillCount} skills`)}`);
      console.log();
    }

    console.log(pc.dim('Install a bundle:'));
    console.log(`  $ npx skills-il add-bundle <slug>`);
    console.log();
    console.log(`Browse at ${pc.cyan('https://agentskills.co.il/bundles')}`);
    console.log();
  } catch (err) {
    console.log(pc.red(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`));
  }
}
