import { dirname, resolve, join } from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';

export async function writeLicenseNotices(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let directory = dirname(resolve(input));
    while (directory !== dirname(directory)) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (manifest.name && manifest.version) {
          packages.set(`${manifest.name}@${manifest.version}`, { directory, manifest });
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      directory = dirname(directory);
    }
  }
  const sections = ['Third-party code bundled in the document editor.\nOriginal licenses remain in effect.\n'];
  for (const [name, { directory, manifest }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const files = (await readdir(directory)).filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name));
    const texts = await Promise.all(files.map(name => readFile(join(directory, name), 'utf8')));
    const source = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
    sections.push(`${name}\nLicense: ${JSON.stringify(manifest.license ?? 'See upstream source')}\nSource: ${source ?? manifest.homepage ?? `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`}\n${texts.join('\n\n')}`);
  }
  await writeFile('dist/THIRD_PARTY_NOTICES.txt', sections.join('\n\n========================================\n\n'));
}
