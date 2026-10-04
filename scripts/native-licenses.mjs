import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(repository, 'apps', 'desktop');
const manifest = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const seen = new Set();
const notices = [];
// react-screenshots declares MIT but omits LICENSE from its published tarball.
// Preserve the upstream notice with the distributed renderer.
const licenseOverrides = new Map([
  ['react-screenshots', join(desktop, 'build', 'third-party', 'react-screenshots-LICENSE.txt')],
]);

function locate(name, from) {
  let directory = from;
  for (;;) {
    const candidate = join(directory, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot find the installed package ${name}`);
    directory = parent;
  }
}

function visit(name, from) {
  const path = locate(name, from);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  seen.add(key);
  const directory = dirname(path);
  const licenseFiles = readdirSync(directory).filter((file) => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(file));
  const override = licenseOverrides.get(pkg.name);
  const text = licenseFiles.map((file) => `${file}\n${readFileSync(join(directory, file), 'utf8')}`).join('\n\n')
    || (override ? readFileSync(override, 'utf8') : '');
  notices.push(`${key}\nLicense: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'unspecified')}\n${text || `Upstream package: https://www.npmjs.com/package/${pkg.name}`}`);
  for (const dependency of Object.keys(pkg.dependencies ?? {})) visit(dependency, directory);
}

for (const name of Object.keys(manifest.dependencies ?? {})) visit(name, desktop);
const output = join(desktop, 'release', 'native-win-x64', 'licenses');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'Renderer-THIRD-PARTY-NOTICES.txt'),
  `PWTools renderer third-party notices\n\n${notices.sort().join('\n\n' + '='.repeat(72) + '\n\n')}\n`);
console.log(`Third-party notices written for ${seen.size} renderer packages.`);
