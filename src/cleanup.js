import fs from 'node:fs';
import path from 'node:path';

import { parseArgs } from './utils.js';

const args = parseArgs(process.argv.slice(2));

const required = ['app-path', 'pr-number'];
for (const key of required) {
	if (!args[key]) {
		console.error(`Missing required arg: --${key}`);
		process.exit(1);
	}
}

const appPath = args['app-path'];
const prNumber = args['pr-number'];
const tempPath = `${appPath}-pr-${prNumber}`;

if (!fs.existsSync(tempPath)) {
	console.log(`Temp stack ${tempPath} does not exist, nothing to clean up`);
	process.exit(0);
}

fs.rmSync(tempPath, { recursive: true });
console.log(`Removed temp stack at ${tempPath}`);
