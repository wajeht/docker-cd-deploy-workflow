import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

export const authPath = 'apps/tinyauth/docker-compose.yml';

export function previewId(appPath, prNumber) {
	const input = `${path.basename(appPath)}:${prNumber}`;
	const digest = createHash('sha256').update(input).digest('hex');
	return `PREVIEW${digest.toUpperCase()}`;
}

// Edit only this preview's two keys, preserving production YAML and comments.
export function updateAccess(text, { appPath, prNumber, hostname, allowlist }) {
	const prefix = `TINYAUTH_APPS_${previewId(appPath, prNumber)}_`;
	const domainKey = `      ${prefix}CONFIG_DOMAIN: `;
	const allowKey = `      ${prefix}OAUTH_WHITELIST: `;
	const lines = text.split('\n');
	const domain = lines.find((line) => line.startsWith(domainKey));
	const hasRule = lines.some((line) => line.startsWith(allowKey));
	const previewHost = `pr-${prNumber}-${path.basename(appPath)}.`;
	if ((domain || hasRule) && !domain?.startsWith(domainKey + previewHost)) {
		throw new Error('Refusing to modify an unowned Tinyauth rule');
	}
	const updated = lines
		.filter((line) => {
			return !line.startsWith(domainKey) && !line.startsWith(allowKey);
		})
		.join('\n');
	if (!allowlist) {
		return updated;
	}
	const rule = `${domainKey}${hostname}\n${allowKey}${allowlist}\n`;
	if (text.includes(rule)) {
		return text;
	}
	const service = updated.match(/^  tinyauth:\n(?:(?: {4}.*|\s*)\n)*/m)?.[0];
	if (!service?.includes('    environment:\n')) {
		throw new Error('Unsupported Tinyauth Compose layout');
	}
	return updated.replace(
		service,
		service.replace('    environment:\n', `    environment:\n${rule}`),
	);
}

export async function main(argv = process.argv.slice(2)) {
	const { values: args } = parseArgs({
		args: argv,
		options: {
			'app-path': { type: 'string' },
			'pr-number': { type: 'string' },
		},
	});
	for (const key of ['app-path', 'pr-number']) {
		if (!args[key]) throw new Error(`Missing required arg: --${key}`);
	}
	const appPath = args['app-path'];
	const prNumber = args['pr-number'];
	const tempPath = `${appPath}-pr-${prNumber}`;
	if (fs.existsSync(authPath)) {
		const text = fs.readFileSync(authPath, 'utf8');
		fs.writeFileSync(authPath, updateAccess(text, { appPath, prNumber, allowlist: null }));
	}

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
