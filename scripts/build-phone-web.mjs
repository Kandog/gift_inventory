// Builds the browser version of the phone app into apps/mobile/dist, which the Python server
// serves at https://<pc>:8443/app. Run from the project folder: npm run build:phone-web
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/mobile');
const out = join(mobile, 'dist');

execSync('npx expo export --platform web --output-dir dist --clear', { cwd: mobile, stdio: 'inherit' });

// The barcode reader Safari needs (Chrome on Android has one built in). Served by the PC so
// scanning works without internet instead of downloading it from a public CDN.
const require = createRequire(join(mobile, 'package.json'));
// zxing-wasm exports its .wasm files by path; resolve from barcode-detector, which depends on it.
const fromDetector = createRequire(require.resolve('barcode-detector'));
const wasm = fromDetector.resolve('zxing-wasm/reader/zxing_reader.wasm');
if (!existsSync(wasm)) throw new Error(`Barcode reader not found at ${wasm}`);
copyFileSync(wasm, join(out, 'zxing_reader.wasm'));
copyFileSync(join(mobile, 'assets/icon.png'), join(out, 'icon.png'));

console.log(`\nPhone web app built in ${out}`);
