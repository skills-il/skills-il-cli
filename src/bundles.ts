import pc from 'picocolors';

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
    // Fetch directory listing from GitHub API
    const res = await fetch(
      `https://api.github.com/repos/${BUNDLES_REPO.owner}/${BUNDLES_REPO.repo}/contents?ref=master`,
      { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'skills-il-cli' } }
    );

    if (!res.ok) {
      console.log(pc.red(`Failed to fetch bundles: ${res.status}`));
      return;
    }

    const items = await res.json() as Array<{ name: string; type: string }>;
    const dirs = items.filter(i => i.type === 'dir');

    if (dirs.length === 0) {
      console.log(pc.dim('No bundles available yet.'));
      return;
    }

    // Fetch bundle.json for each directory
    const bundles: Array<{ slug: string; data: BundleJson }> = [];
    for (const dir of dirs) {
      try {
        const jsonRes = await fetch(
          `https://raw.githubusercontent.com/${BUNDLES_REPO.owner}/${BUNDLES_REPO.repo}/master/${dir.name}/bundle.json`,
          { headers: { 'User-Agent': 'skills-il-cli' } }
        );
        if (jsonRes.ok) {
          const data = await jsonRes.json() as BundleJson;
          bundles.push({ slug: dir.name, data });
        }
      } catch {
        // Skip bundles with invalid json
      }
    }

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
