This private package replaces only `@typescript-eslint/typescript-estree`'s
`tinyglobby` dependency through the root npm override. Picomatch has no published
fix for [CVE-2026-112366](https://github.com/advisories/GHSA-fc5q-39xc-vjpf),
so leaving tinyglobby installed retains a vulnerable glob parser even with the
latest typescript-eslint.

The adapter implements the two functions used by typescript-estree 8.73.0:
`isDynamicPattern` and synchronous project discovery with `cwd`, `ignore`, and
`expandDirectories: false`. Node-glob 14 uses patched minimatch 11. It returns
files, follows directory symlinks, excludes dotfiles, and expands brace patterns.
Unsupported options throw to make future dependency incompatibilities visible.
This is not a general replacement for tinyglobby.

`test/lint-glob.test.js` exercises project discovery through ESLint, filesystem
matching and ignored projects, and the advisory patterns in a child process with
a deadline. Remove this package and the override when upstream dependencies
provide a patched release; rerun `npm ci`, `npm audit`, and `npm run check`.
