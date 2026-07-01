import js from '@eslint/js';
import ts from 'typescript-eslint';

export default [
  js.configs.recommended,
  ...ts.configs.recommended.map(config => ({
    ...config,
    languageOptions: {
      ...config.languageOptions,
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  })),
  {
    files: ['src/**/*.{ts,js}'],
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-empty': 'error',
      'no-case-declarations': 'error',
    },
  },
  {
    files: ['**/*.{test,spec}.ts', 'test/**', 'tests/**'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': 'off',
      'no-case-declarations': 'warn',
    },
  },
];
