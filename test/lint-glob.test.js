const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs/promises');
const os = require ('node:os');
const path = require ('node:path');
const { createRequire } = require ('node:module');
const { spawnSync } = require ('node:child_process');
const { ESLint } = require ('eslint');

const parserRequire = createRequire (require.resolve ('@typescript-eslint/parser'));
const estreeRequire = createRequire (parserRequire.resolve ('@typescript-eslint/typescript-estree'));
const globModule = estreeRequire.resolve ('tinyglobby');
const { globSync, isDynamicPattern } = require (globModule);

test ('lint project discovery preserves files, braces, ignores and symlink traversal', async t => {
    const dir = await fs.mkdtemp (path.join (os.tmpdir (), 'borg-lint-glob-'));
    t.after (() => fs.rm (dir, { recursive: true, force: true }));
    for (const name of ['packages/a/tsconfig.json', 'packages/b/tsconfig.json', 'node_modules/hidden/tsconfig.json', '.hidden/tsconfig.json']) {
        await fs.mkdir (path.dirname (path.join (dir, name)), { recursive: true });
        await fs.writeFile (path.join (dir, name), '{}');
    }
    await fs.mkdir (path.join (dir, 'directory/tsconfig.json'), { recursive: true });
    await fs.symlink (path.join (dir, 'packages/a'), path.join (dir, 'linked'), 'dir');
    const options = { cwd: dir, expandDirectories: false, ignore: ['**/node_modules/**'] };
    const normalize = files => files.map (file => file.split (path.sep).join ('/')).sort ();
    assert.equal (isDynamicPattern ('./tsconfig.json'), false);
    assert.equal (isDynamicPattern ('packages/{a,b}/tsconfig.json'), true);
    assert.deepEqual (normalize (globSync ('**/tsconfig.json', options)), ['linked/tsconfig.json', 'packages/a/tsconfig.json', 'packages/b/tsconfig.json']);
    assert.deepEqual (normalize (globSync ('packages/{a,b}/tsconfig.json', options)), ['packages/a/tsconfig.json', 'packages/b/tsconfig.json']);
    assert.throws (() => globSync ('**/*', { ...options, expandDirectories: true }), /Unsupported/);
    assert.throws (() => globSync ('**/*', { ...options, unknownOption: true }), /Unsupported/);
});

test ('advisory repeated-extglob patterns finish within a bounded child process', async t => {
    const dir = await fs.mkdtemp (path.join (os.tmpdir (), 'borg-glob-redos-'));
    t.after (() => fs.rm (dir, { recursive: true, force: true }));
    await fs.writeFile (path.join (dir, 'a'.repeat (128) + 'c'), '');
    const result = spawnSync (process.execPath, ['-e', `
        const assert = require ('node:assert/strict');
        const { globSync } = require (process.argv[1]);
        for (const pattern of ['+(*)b', '+(*a)b', '*(*)b', '*(*a)b']) {
            assert.deepEqual (globSync (pattern, { cwd: process.argv[2], expandDirectories: false, ignore: [] }), []);
        }
    `, globModule, dir], { timeout: 5000, encoding: 'utf8' });
    assert.ifError (result.error);
    assert.equal (result.status, 0, result.stderr);
});

test ('typed ESLint resolves project globs using the installed adapter', { timeout: 30000 }, async () => {
    const eslint = new ESLint ({ overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parserOptions: { project: ['./tsconfig*.json'] } } }] });
    const results = await eslint.lintText ('export const auditCompatibility: number = 1;\n', { filePath: 'config.ts' });
    assert.equal (results.length, 1);
    assert.deepEqual (results[0].messages, []);
});
