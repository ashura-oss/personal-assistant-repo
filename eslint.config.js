const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([expoConfig, { ignores: ['**/.expo/**', '**/dist/**', '**/dist-web/**', '**/node_modules/**', '**/coverage/**'] }]);
