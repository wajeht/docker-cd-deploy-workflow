import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { main as deploy } from './temp-compose.js';
import { main as cleanup } from './temp-cleanup.js';
import { authPath } from './preview-access.js';
import { validateApiConfig } from './wait-preview.js';

export function git(args) {
	return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Recompute the operation against the latest main after a rejected push. A text
// rebase cannot safely merge two edits to the shared Tinyauth environment.
export async function pushPreview({ prepare, paths, message, attempts = 5 }) {
	if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Preview push requires a clean checkout');
	git(['config', 'user.name', 'github-actions[bot]']);
	git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
	for (let attempt = 1; attempt <= attempts; attempt++) {
		git(['fetch', 'origin', 'main']);
		git(['reset', '--hard', 'origin/main']);
		const result = await prepare();
		for (const file of paths) {
			if (fs.existsSync(file) || git(['ls-files', '--', file])) git(['add', '-A', '--', file]);
		}
		if (git(['diff', '--cached', '--name-only'])) git(['commit', '-m', message]);
		try {
			git(['push', 'origin', 'HEAD:main']);
			return { ...result, commit: git(['rev-parse', 'HEAD']) };
		} catch {
			if (attempt === attempts) throw new Error('Preview push failed after retries');
			console.log(`Concurrent update; retrying preview operation (${attempt}/${attempts})`);
		}
	}
}

export async function main(argv = process.argv.slice(2)) {
	const { values: args } = parseArgs({ args: argv, options: {
		action: { type: 'string' }, message: { type: 'string' },
		'app-path': { type: 'string' }, 'pr-number': { type: 'string' },
		'service-name': { type: 'string' }, tag: { type: 'string' },
		'repo-owner': { type: 'string' }, 'auth-middleware': { type: 'string' },
		'app-repo-path': { type: 'string' },
	} });
	if (!['deploy', 'cleanup'].includes(args.action) || !args.message) throw new Error('An action and message are required');
	if (!/^apps\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args['app-path']) || !/^[1-9][0-9]*$/.test(args['pr-number'])) {
		throw new Error('Invalid app path or PR number');
	}
	const scriptArgs = Object.entries(args).filter(([key]) => !['action', 'message'].includes(key)).flatMap(([key, value]) => [`--${key}`, value]);
	const result = await pushPreview({
		paths: [`${args['app-path']}-pr-${args['pr-number']}`, authPath],
		message: args.message,
		prepare: async () => {
			if (fs.existsSync(authPath)) validateApiConfig();
			return (args.action === 'deploy' ? deploy : cleanup)([...scriptArgs, '--manage-access']);
		},
	});
	if (process.env.GITHUB_OUTPUT) {
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `commit=${result.commit}\nauth-managed=${result.authManaged}\n`);
	}
	return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((err) => { console.error(err.message); process.exit(1); });
}
