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

// Keep Home Ops comments (including lint exceptions) and all unrelated rules intact.
export function updateAccess(text, { appPath, prNumber, hostname, allowlist }) {
	const id = previewId(appPath, prNumber);
	const prefix = `TINYAUTH_APPS_${id}_`;
	const start = `      # preview-access:${id}:start`;
	const end = `      # preview-access:${id}:end`;
	const pattern = new RegExp(`^${start}\\n[\\s\\S]*?^${end}\\n`, 'gm');
	const blocks = [...text.matchAll(pattern)];
	if (blocks.length > 1) {
		throw new Error('Duplicate preview access blocks');
	}
	if (!blocks.length && (text.includes(start) || text.includes(end))) {
		throw new Error('Malformed preview access block');
	}
	const keys = text.match(new RegExp(`^      ${prefix}[^:]+:`, 'gm')) || [];
	if (keys.length && !blocks.length) {
		throw new Error('Refusing to modify an unowned Tinyauth rule');
	}
	if (blocks.length) {
		const lines = blocks[0][0]
			.split('\n')
			.filter((line) => line.trim() && !line.trim().startsWith('#'));
		const allowedKey = new RegExp(
			`^      ${prefix}(CONFIG_DOMAIN|OAUTH_WHITELIST): `,
		);
		if (lines.some((line) => !allowedKey.test(line))) {
			throw new Error('Unexpected content in preview access block');
		}
	}
	let updated = text.replace(pattern, '');
	if (!allowlist) {
		return updated;
	}
	if (!/^\$\{TINYAUTH_(ADMIN|USERS)_ALLOW:\?required\}$/.test(allowlist)) {
		throw new Error('Unsupported preview allowlist');
	}
	if (!/^pr-[1-9][0-9]*-[a-z0-9-]+\.[a-z0-9.-]+$/.test(hostname)) {
		throw new Error('Invalid preview hostname');
	}
	const block = [
		start,
		`      ${prefix}CONFIG_DOMAIN: ${hostname}`,
		`      ${prefix}OAUTH_WHITELIST: ${allowlist}`,
		end,
		'',
	].join('\n');
	if (blocks[0]?.[0] === block) {
		return text;
	}
	// Require the standard Home Ops service layout instead of guessing a YAML insertion point.
	const service = updated.match(/^  tinyauth:\n(?:(?: {4}.*|\s*)\n)*/m)?.[0];
	if (!service || !/^    environment:\n/m.test(service)) {
		throw new Error('Unsupported Tinyauth Compose layout');
	}
	updated = updated.replace(
		service,
		service.replace('    environment:\n', `    environment:\n${block}`),
	);
	return updated;
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
