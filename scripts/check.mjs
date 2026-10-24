#!/usr/bin/env node
import { readdir, readFile, lstat, access } from 'node:fs/promises';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const required = ['SKILL.md','README.md','LICENSE','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md',
  'docs/architecture.md','docs/refactor-plan.md','docs/testing.md','docs/migration.md','.github/workflows/ci.yml'];
for (const path of required) await access(join(root, path)).catch(() => failures.push(`Missing ${path}`));
const skill = await readFile(join(root, 'SKILL.md'), 'utf8');
if (!/^---\r?\nname: chatgpt-web\r?\ndescription:/m.test(skill)) failures.push('Invalid skill frontmatter');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.license !== 'MIT' || !pkg.private || pkg.dependencies) failures.push('Unexpected package metadata or runtime dependencies');
const forbiddenRoots = new Set(['data','state','artifacts','coverage','node_modules']);
let modules = 0, files = 0;
async function walk(directory) {
  for (const name of await readdir(directory)) {
    if (name === '.git') continue;
    const path = join(directory, name);
    const rel = relative(root, path).replaceAll('\\', '/');
    const info = await lstat(path);
    if (info.isSymbolicLink()) { failures.push(`Symlink must not be distributed: ${rel}`); continue; }
    if (info.isDirectory()) {
      if (directory === root && forbiddenRoots.has(name)) failures.push(`Runtime directory in source: ${rel}`);
      else await walk(path);
      continue;
    }
    files++;
    if ((name.startsWith('.env') && name !== '.env.example') || /\.(zip|tgz|log|tmp)$/.test(name)) failures.push(`Private/build artifact in source: ${rel}`);
    const text = await readFile(path, 'utf8');
    if (/\b[A-Z]:[\\/]+Users[\\/]+(?!Public\b|EXAMPLE\b)[A-Za-z0-9_.-]+[\\/]/i.test(text) || /\/(?:home|Users)\/(?!example\/)[A-Za-z0-9_.-]+\//.test(text)) failures.push(`Personal absolute path: ${rel}`);
    if (/chatgpt\.com\/c\/[a-f0-9]{8}-[a-f0-9-]{20,}/i.test(text)) failures.push(`Real-looking conversation ID: ${rel}`);
    for (const email of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g))
      if (!['example.com','example.invalid'].includes(email[1].toLowerCase()) && !email[1].endsWith('.invalid')) failures.push(`Non-example email: ${rel}`);
    if (extname(path) === '.mjs') {
      modules++;
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) failures.push(`Syntax failure: ${rel}\n${result.stderr}`);
    }
    if (extname(path) === '.md') for (const link of text.matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(link[1])) continue;
      await access(join(dirname(path), link[1].split('#')[0])).catch(() => failures.push(`Broken local link: ${rel} -> ${link[1]}`));
    }
  }
}
await walk(root);
if (failures.length) {
  console.error([...new Set(failures)].join('\n'));
  process.exitCode = 1;
} else console.log(`Checked ${files} source files, ${modules} ESM modules, skill metadata, local links and publication exclusions.`);
