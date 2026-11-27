const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const stableTag = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const metadata = new Set(['package.json', 'package-lock.json']);
const tuple = (tag) => stableTag.exec(tag)?.slice(1).map(Number);
const compare = (a, b) => a.map((n, i) => n - b[i]).find(Boolean) || 0;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

function classifyRelease(previous, next, paths) {
  const a = tuple(previous);
  const b = tuple(next);
  if (!b || (previous && (!a || a[0] !== b[0] || compare(b, a) <= 0))) throw new Error('Invalid release version progression');
  if (!a || a[1] !== b[1]) {
    if (b[2] !== 0 || (a && b[1] !== a[1] + 1)) throw new Error('Desktop version must increment the second segment and reset the third');
    return 'desktop';
  }
  const runtime = paths.filter((file) => !metadata.has(file) && file !== 'README.md' &&
    !file.startsWith('renderer/') && !file.startsWith('docs/') && !file.startsWith('test/'));
  if (runtime.length) throw new Error(`Release has desktop changes: ${runtime.join(', ')}`);
  if (!paths.some((file) => file.startsWith('renderer/'))) throw new Error('Patch release must change renderer files');
  return 'renderer';
}

function normalizeVersionMetadata(file, json) {
  const clean = structuredClone(json);
  delete clean.version;
  if (file === 'package-lock.json' && clean.packages?.['']) delete clean.packages[''].version;
  return clean;
}

function classifyTag(tag) {
  const current = tuple(tag);
  if (!current) throw new Error('Expected stable release version tag');
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  if (`v${pkg.version}` !== tag || pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version) {
    throw new Error('Tag, package.json and package-lock.json versions must match');
  }
  const priorTags = git('tag', '--merged', 'HEAD').split('\n').filter((name) => name && name !== tag && tuple(name));
  priorTags.sort((a, b) => compare(tuple(b), tuple(a)));
  const previous = priorTags[0];
  const paths = previous ? git('diff', '--no-renames', '--name-only', '-z', previous, 'HEAD').split('\0').filter(Boolean) : [];
  const kind = classifyRelease(previous, tag, paths);
  if (kind === 'renderer') {
    const base = `v${current[0]}.${current[1]}.0`;
    if (!priorTags.includes(base)) throw new Error('Patch requires an ancestor desktop base tag');
    const basePaths = git('diff', '--no-renames', '--name-only', '-z', base, 'HEAD').split('\0').filter(Boolean);
    classifyRelease(base, tag, basePaths);
    for (const file of metadata) {
      const before = JSON.parse(git('show', `${base}:${file}`));
      const after = JSON.parse(git('show', `HEAD:${file}`));
      if (!isDeepStrictEqual(normalizeVersionMetadata(file, before), normalizeVersionMetadata(file, after))) {
        throw new Error(`${file} contains desktop changes outside version metadata`);
      }
    }
  }
  return kind;
}

if (require.main === module) {
  try { console.log(classifyTag(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { classifyRelease, normalizeVersionMetadata, classifyTag };
