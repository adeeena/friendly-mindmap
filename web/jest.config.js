// CommonJS so Node's native type stripping and ts-node are not involved in loading config.
const { createCjsPreset } = require('jest-preset-angular/presets');

const presetConfig = createCjsPreset({ tsconfig: '<rootDir>/tsconfig.spec.json' });

/** @type {import('jest').Config} */
module.exports = {
  ...presetConfig,
  setupFilesAfterEnv: ['<rootDir>/setup-jest.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/e2e/'],
};
