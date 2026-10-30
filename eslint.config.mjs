import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config (
    { ignores: ['dist/**', 'node_modules/**', 'config.js', 'config_example.js', 'private/**', 'data/**', 'log/**', 'test_data.js'] },
    {
        files: ['**/*.{js,cjs,mjs,ts}'],
        languageOptions: { globals: globals.node },
        rules: {
            'constructor-super': 'error', 'for-direction': 'error', 'getter-return': 'error',
            'no-async-promise-executor': 'error', 'no-compare-neg-zero': 'error',
            'no-cond-assign': ['error', 'except-parens'], 'no-constant-binary-expression': 'error',
            'no-dupe-args': 'error', 'no-dupe-class-members': 'error', 'no-dupe-else-if': 'error',
            'no-dupe-keys': 'error', 'no-duplicate-case': 'error', 'no-func-assign': 'error',
            'no-import-assign': 'error', 'no-promise-executor-return': 'error',
            'no-unexpected-multiline': 'error', 'no-unreachable': 'error',
            'no-unsafe-finally': 'error', 'no-unsafe-optional-chaining': 'error', 'valid-typeof': 'error'
        }
    },
    {
        files: ['public/*.js'],
        languageOptions: { globals: globals.browser, sourceType: 'script' },
        rules: { 'no-undef': 'error' }
    },
    {
        files: ['**/*.ts'],
        extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
        languageOptions: { parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-non-null-assertion': 'error',
            '@typescript-eslint/no-require-imports': 'error'
        }
    }
);
