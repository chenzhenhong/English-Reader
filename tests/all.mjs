/**
 * Test entry point: runs every suite in order and exits non-zero on failure.
 * Each suite is plain Node (no test framework) so the plugin keeps zero
 * dependencies.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
  ['behaviour', 'tests/behaviour.mjs'],
  ['user-state', 'tests/user-state.mjs'],
  ['failure-diagnostics', 'tests/failure-diagnostics.mjs'],
  ['revalidate', 'tests/revalidate.mjs'],
  ['sources', 'tests/sources.mjs'],
  ['article-count', 'tests/article-count.mjs'],
  ['knowledge-optin', 'tests/knowledge-optin.mjs'],
  ['study-history', 'tests/study-history.mjs'],
  ['word-limit', 'tests/word-limit.mjs'],
  ['discovery-persist', 'tests/discovery-persist.mjs'],
  ['cleaner', 'tests/cleaner.mjs'],
  ['stage-counter', 'tests/stage-counter.mjs'],
  ['bento', 'tests/bento.mjs'],
  ['bundle', 'tests/bundle.mjs'],
  ['deep-render', 'tests/deep-render.mjs'],
  ['speech', 'tests/speech.mjs'],
  ['speech-client', 'tests/speech-client.mjs'],
  ['schema-check', 'tests/schema-check.mjs'],
];

let failed = 0;
// The render suites read the bundle's test export, which the marker file
// enables; the release bundle is rebuilt afterwards so a shipped artifact never
// carries the test surface.
const root = join(here, '..');
writeFileSync(join(root, '.debug-exports'), '', 'utf8');
const build = spawnSync(process.execPath, [join(root, 'scripts/build-client.mjs')], { encoding: 'utf8' });
if (build.status !== 0) {
  console.log('client build failed:', build.stderr);
  process.exit(1);
}
for (const [name, file] of suites) {
  const run = spawnSync(process.execPath, [join(here, '..', file)], { encoding: 'utf8' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd();
  const ok = run.status === 0;
  console.log(`\n=== ${name} ${ok ? 'PASS' : 'FAIL'} ===`);
  // Keep the suite's own verdict lines, not its full trace.
  const verdict = output.split('\n').filter((line) => /✓|✗|passed|failed|crashed|all pages|renders|registrations/.test(line));
  console.log(verdict.length > 0 ? verdict.join('\n') : output.slice(0, 2000));
  if (!ok) {
    failed += 1;
    if (verdict.length === 0) console.log(output);
  }
}
// Restore the release artifact.
rmSync(join(root, '.debug-exports'), { force: true });
const release = spawnSync(process.execPath, [join(root, 'scripts/build-client.mjs')], { encoding: 'utf8' });
if (release.status !== 0) {
  console.log('release rebuild failed:', release.stderr);
  failed += 1;
}
console.log(`\n${failed === 0 ? 'all suites passed' : `${failed} suite(s) failed`}`);
process.exitCode = failed === 0 ? 0 : 1;
