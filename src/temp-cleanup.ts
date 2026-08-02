import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

type TempCleanupArgs = {
	'app-path'?: string;
	'pr-number'?: string;
};

function requireArg(args: TempCleanupArgs, key: keyof TempCleanupArgs): string {
	const value = args[key];
	if (!value) throw new Error(`Missing required arg: --${key}`);
	return value;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			'app-path': { type: 'string' },
			'pr-number': { type: 'string' },
		},
	});
	const args = values as TempCleanupArgs;
	const appPath = requireArg(args, 'app-path');
	const prNumber = requireArg(args, 'pr-number');
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
