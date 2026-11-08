/**
 * Bundle contract check: the browser artifact must register the exact id the
 * package declares, return a plugin with `apply`, and install both slots while
 * keeping effects inside the plugin's own context.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let registration;
const sandbox = { window: { __ModuleLoader__: { load(r) { registration = r; } } }, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures += 1;
};

check('registers the package id', registration.id === pkg.name, `${registration?.id} vs ${pkg.name}`);

const fakeReact = {
  createElement: () => ({ type: 'div' }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: () => ({ current: 0 }),
  Fragment: 'fragment',
};
const plugin = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact;
  throw new Error(`the bundle must not require "${specifier}"`);
});
check('factory returns a plugin object', typeof plugin?.apply === 'function', typeof plugin);
check('declares only host services', Array.isArray(plugin.inject), plugin.inject);

const registered = [];
const effects = [];
const localeRegistrations = [];
plugin.apply({
  effect(fn, label) { effects.push(label); fn(); return () => {}; },
  locale: {
    register(ns, dicts) {
      localeRegistrations.push({ ns, dicts });
      return () => {};
    },
    bind: () => (key) => key,
  },
  slots: {
    inject(key, cb) { cb(); return () => {}; },
    register(options) { registered.push(options); return () => {}; },
  },
});

check('registers its locale namespace', localeRegistrations.length === 1 && localeRegistrations[0].ns === 'englishReader', JSON.stringify(localeRegistrations.map((r) => r.ns)));
const langs = Object.keys(localeRegistrations[0]?.dicts ?? {});
check('ships English and Chinese dictionaries', langs.includes('en') && langs.includes('zh'), langs.join(','));
check('sidebar panel uses the package panel id', registered.some((o) => o.name === 'sidebar.panellist' && o.id === 'english-reader'));
check('main panel uses the same key', registered.some((o) => o.name === 'main' && o.key === 'english-reader'));
check('labels are lazy (locale live switch)', registered.every((o) => o.label === undefined || typeof o.label === 'function'));
check('every resource is an effect', effects.length >= 1 && effects[0].includes('dictionaries'), effects.join(','));

const pkgClient = pkg.dsh?.client ?? {};
check('client platform is web', pkgClient.platform === 'web', pkgClient.platform);
check('no external modules beyond the seeds', (pkgClient.external ?? []).length === 0, JSON.stringify(pkgClient.external));
check('bundle patch is declared', Boolean(pkg.dsh?.bundle?.patch));
check('icon export exists', Boolean(pkg.exports?.['./icon']));
check('locale export exists', Boolean(pkg.exports?.['./locale/*.json']));

console.log(failures === 0 ? 'bundle contract ok' : `${failures} contract check(s) failed`);
if (failures > 0) process.exitCode = 1;
