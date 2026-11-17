import { defineConfig } from 'vite';

// Our own code (the app's and the engine's, the fit worker too; not three.js) is obfuscated module
// by module, then minified. Names everywhere become meaningless, and in the WGSL modules (the GPU
// kernels, read once to build the pipelines) the strings go to an encoded table too. Elsewhere the
// strings stay: the table's lookups cost the CPU physics 3× its time (8.5 ms a step instead of 2.5
// with 50 parts), names alone nothing. No control-flow flattening, dead code or self-defence.
// OBFUSCATE=0 npm run build leaves the code readable (minified only). The obfuscator is loaded for
// builds only: `npm run dev` runs without it installed.
const NAMES = {
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  stringArray: false,
  splitStrings: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: false,
  selfDefending: false,
  debugProtection: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  sourceMap: false,
  reservedStrings: ['__VITE', '\\.worker'], // Vite's placeholders for the worker's and other files' final names
};
const KERNELS = {
  ...NAMES,
  stringArray: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
};
const KERNEL_FILES = /(\.wgsl\.js|GpuKernels\.js)$/;

const obfuscate = (JavaScriptObfuscator) => ({
  name: 'obfuscate',
  apply: 'build',
  enforce: 'post', // after Vite's own transforms: the worker's URL is a placeholder by then
  transform(code, id) {
    const file = id.split('?')[0];
    if (!file.endsWith('.js') || file.includes('/node_modules/')) return null;
    const options = KERNEL_FILES.test(file) ? KERNELS : NAMES;
    return { code: JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode(), map: null };
  },
});

export default defineConfig(async ({ command }) => {
  const obfuscator = command === 'build' && process.env.OBFUSCATE !== '0' ? (await import('javascript-obfuscator')).default : null;
  const plugins = () => (obfuscator ? [obfuscate(obfuscator)] : []);
  return {
    base: './', // the built site works from any folder
    server: {
      // the core package is linked from ../core by the npm workspace
      fs: { allow: ['..'] },
    },
    plugins: plugins(),
    worker: { format: 'es', plugins },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 1500, // three.js
      sourcemap: false,
    },
  };
});
