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
