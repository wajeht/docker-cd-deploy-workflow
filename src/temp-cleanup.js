import fs from 'node:fs';
import { parseArgs, runMain, tempStackPath } from './utils.js';

export async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv, { required: ['app-path', 'pr-number'] });
	const appPath = args['app-path'];
	const prNumber = args['pr-number'];
	const tempPath = tempStackPath(appPath, prNumber);

	if (!fs.existsSync(tempPath)) {
		console.log(`Temp stack ${tempPath} does not exist, nothing to clean up`);
		return;
	}

	fs.rmSync(tempPath, { recursive: true });
	console.log(`Removed temp stack at ${tempPath}`);
}

runMain(import.meta.url, main);
