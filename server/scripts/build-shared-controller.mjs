import { build } from 'esbuild';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../..');
await build({
  entryPoints: [resolve(repositoryRoot, 'src/services/controller.shared.ts')],
  outfile: resolve(import.meta.dirname, '../dist/sharedControllerNode.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  plugins: [{
    name: 'deny-native-runtime-imports',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (/^(?:expo(?:$|[-/])|react-native(?:$|\/))/.test(args.path)) {
          return { errors: [{ text: `Node controller import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

await build({
  entryPoints: [resolve(repositoryRoot, 'src/cloud/ownedWorkspaceRuntime.node.ts')],
  outfile: resolve(import.meta.dirname, '../dist/ownedWorkspaceRuntime.node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  plugins: [{
    name: 'preserve-server-module-identity',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/\.\.\/server\/src\/.+\.js$/ }, (args) => ({
        path: `./${args.path.slice('../../server/src/'.length)}`,
        external: true,
      }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (/^(?:expo(?:$|[-/])|react-native(?:$|\/))/.test(args.path)) {
          return { errors: [{ text: `Node runtime import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

await build({
  entryPoints: [resolve(repositoryRoot, 'src/cloud/workspaceCommands.node.ts')],
  outfile: resolve(import.meta.dirname, '../dist/workspaceCommands.node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  plugins: [{
    name: 'preserve-server-module-identity',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/\.\.\/server\/src\/.+\.js$/ }, (args) => ({
        path: `./${args.path.slice('../../server/src/'.length)}`,
        external: true,
      }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (/^(?:expo(?:$|[-/])|react-native(?:$|\/))/.test(args.path)) {
          return { errors: [{ text: `Node runtime import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

await build({
  entryPoints: [resolve(repositoryRoot, 'src/cloud/periodSummarySources.node.ts')],
  outfile: resolve(import.meta.dirname, '../dist/periodSummarySources.node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  plugins: [{
    name: 'preserve-server-module-identity',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/\.\.\/server\/src\/.+\.js$/ }, (args) => ({
        path: `./${args.path.slice('../../server/src/'.length)}`,
        external: true,
      }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (/^(?:expo(?:$|[-/])|react-native(?:$|\/))/.test(args.path)) {
          return { errors: [{ text: `Node source resolver import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

await build({
  entryPoints: [resolve(repositoryRoot, 'src/cloud/periodSummaryPaidWork.node.ts')],
  outfile: resolve(import.meta.dirname, '../dist/periodSummaryPaidWork.node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  plugins: [{
    name: 'preserve-period-summary-module-identity',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\/periodSummarySources\.node\.js$/ }, () => ({
        path: './periodSummarySources.node.mjs',
        external: true,
      }));
      buildApi.onResolve({ filter: /^\.\.\/\.\.\/server\/src\/.+\.js$/ }, (args) => ({
        path: `./${args.path.slice('../../server/src/'.length)}`,
        external: true,
      }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (/^(?:expo(?:$|[-/])|react-native(?:$|\/))/.test(args.path)) {
          return { errors: [{ text: `Node period-summary paid-work import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

await build({
  entryPoints: [resolve(repositoryRoot, 'src/cloud/periodSummaryRecovery.node.ts')],
  outfile: resolve(import.meta.dirname, '../dist/periodSummaryRecovery.node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  plugins: [{
    name: 'preserve-server-module-identity',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/\.\.\/server\/src\/.+\.js$/ }, (args) => ({
        path: `./${args.path.slice('../../server/src/'.length)}`,
        external: true,
      }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (/^(?:expo(?:$|[-/])|react-native(?:$|\/))/.test(args.path)) {
          return { errors: [{ text: `Node period-summary recovery import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

await build({
  entryPoints: [resolve(repositoryRoot, 'src/cloud/workspaceHttp.node.ts')],
  outfile: resolve(import.meta.dirname, '../dist/workspaceHttp.node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  plugins: [{
    name: 'preserve-server-module-identity',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/\.\.\/server\/src\/.+\.js$/ }, (args) => ({
        path: `./${args.path.slice('../../server/src/'.length)}`,
        external: true,
      }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (/^(?:expo(?:$|[-/])|react-native(?:$|\/))/.test(args.path)) {
          return { errors: [{ text: `Node runtime import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

await build({
  entryPoints: [resolve(repositoryRoot, 'src/cloud/applicationHost.node.ts')],
  outfile: resolve(import.meta.dirname, '../dist/applicationHost.node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  plugins: [{
    name: 'preserve-server-module-identity',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/\.\.\/server\/src\/.+\.js$/ }, (args) => ({
        path: `./${args.path.slice('../../server/src/'.length)}`,
        external: true,
      }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (/^(?:expo(?:$|[-/])|react-native(?:$|\/))/.test(args.path)) {
          return { errors: [{ text: `Node application host import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

await build({
  entryPoints: [resolve(repositoryRoot, 'src/cloud/providerResponseLifetime.node.ts')],
  outfile: resolve(import.meta.dirname, '../dist/providerResponseLifetime.node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  plugins: [{
    name: 'deny-native-runtime-imports',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (/^(?:expo(?:$|[-/])|react-native(?:$|\/))/.test(args.path)) {
          return { errors: [{ text: `Node response lifetime import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});
