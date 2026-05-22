import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './utils.js';

export async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv, { required: ['app-path', 'pr-number'] });
	const appPath = args['app-path'];
	const prNumber = args['pr-number'];
	const tempPath = `${appPath}-pr-${prNumber}`;

	if (!fs.existsSync(tempPath)) {
		console.log(`Temp stack ${tempPath} does not exist, nothing to clean up`);
		return;
	}

	fs.rmSync(tempPath, { recursive: true });
	console.log(`Removed temp stack at ${tempPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}
