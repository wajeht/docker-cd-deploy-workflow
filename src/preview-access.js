import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

export const authPath = 'apps/tinyauth/docker-compose.yml';
export const adminAllow = '${TINYAUTH_ADMIN_ALLOW:?required}';
export const usersAllow = '${TINYAUTH_USERS_ALLOW:?required}';

export function labelsOf(service) {
	return Array.isArray(service.labels) ? service.labels : Object.entries(service.labels || {}).map(([key, value]) => `${key}=${value}`);
}

export function hasTinyauth(middlewares = '') {
	return middlewares.split(',').some((value) => ['tinyauth@file', 'tinyauth-no-ratelimit@file'].includes(value.trim()));
}

export function previewId(appPath, prNumber) {
	return `PREVIEW${createHash('sha256').update(`${path.basename(appPath)}:${prNumber}`).digest('hex').toUpperCase()}`;
}

export function authEnvironment(text) {
	const doc = yaml.load(text);
	const env = doc?.services?.tinyauth?.environment;
	if (!env || Array.isArray(env) || typeof env !== 'object') throw new Error('Tinyauth requires a mapping environment');
	if (env.TINYAUTH_AUTH_ACLS_POLICY !== 'deny') throw new Error('Tinyauth must deny unknown domains');
	if (doc['x-docker-cd']?.rolling_update !== false) throw new Error('Tinyauth must use rolling_update: false for environment recreation');
	return env;
}

// One preview hostname cannot represent two different access policies safely.
export function inheritedAllowlist(services, env) {
	const allowlists = new Set();
	for (const service of Object.values(services)) {
		const labels = labelsOf(service).filter((label) => !label.includes('redirect'));
		for (const label of labels) {
			const match = label.match(/^traefik\.http\.routers\.([^.]+)\.middlewares=(.*)$/);
			if (!match || !hasTinyauth(match[2])) continue;
			const rule = labels.find((value) => value.startsWith(`traefik.http.routers.${match[1]}.rule=`));
			const hosts = [...(rule || '').matchAll(/Host\(`([^`]+)`\)/g)].map((value) => value[1]);
			if (!hosts.length) throw new Error('Protected router has no exact Host rule');
			for (const host of hosts) {
				const rules = Object.keys(env).filter((key) => /^TINYAUTH_APPS_.+_CONFIG_DOMAIN$/.test(key) && env[key] === host);
				if (rules.length !== 1) throw new Error(`Expected one Tinyauth rule for ${host}`);
				const allow = env[rules[0].replace(/CONFIG_DOMAIN$/, 'OAUTH_WHITELIST')];
				if (![adminAllow, usersAllow].includes(allow)) throw new Error(`Unsupported Tinyauth allowlist for ${host}`);
				allowlists.add(allow);
			}
		}
	}
	if (allowlists.size > 1) throw new Error('Preview routers have different Tinyauth allowlists');
	return [...allowlists][0] || null;
}

// Keep Home Ops comments (including lint exceptions) and all unrelated rules intact.
export function updateAccess(text, { appPath, prNumber, hostname, allowlist }) {
	const env = authEnvironment(text);
	const id = previewId(appPath, prNumber);
	const prefix = `TINYAUTH_APPS_${id}_`;
	const start = `      # preview-access:${id}:start`;
	const end = `      # preview-access:${id}:end`;
	const pattern = new RegExp(`^${start}\\n[\\s\\S]*?^${end}\\n`, 'gm');
	const blocks = [...text.matchAll(pattern)];
	if (blocks.length > 1) throw new Error('Duplicate preview access blocks');
	if (!blocks.length && (text.includes(start) || text.includes(end))) throw new Error('Malformed preview access block');
	const keys = Object.keys(env).filter((key) => key.startsWith(prefix));
	if (keys.length && !blocks.length) throw new Error('Refusing to modify an unowned Tinyauth rule');
	if (blocks.length) {
		const blockEnv = yaml.load(blocks[0][0]) || {};
		if (Object.keys(blockEnv).some((key) => ![`${prefix}CONFIG_DOMAIN`, `${prefix}OAUTH_WHITELIST`].includes(key))) {
			throw new Error('Unexpected content in preview access block');
		}
	}
	let updated = text.replace(pattern, '');
	if (!allowlist) return updated;
	if (![adminAllow, usersAllow].includes(allowlist)) throw new Error('Unsupported preview allowlist');
	if (!/^pr-[1-9][0-9]*-[a-z0-9-]+\.[a-z0-9.-]+$/.test(hostname)) throw new Error('Invalid preview hostname');
	if (Object.entries(env).some(([key, value]) => key.endsWith('_CONFIG_DOMAIN') && !key.startsWith(prefix) && value === hostname)) {
		throw new Error('Preview hostname already belongs to another rule');
	}
	const block = `${start}\n      ${prefix}CONFIG_DOMAIN: ${hostname}\n      ${prefix}OAUTH_WHITELIST: ${allowlist}\n${end}\n`;
	if (blocks[0]?.[0] === block) return text;
	// Require the standard Home Ops service layout instead of guessing a YAML insertion point.
	const service = updated.match(/^  tinyauth:\n(?:(?: {4}.*|\s*)\n)*/m)?.[0];
	if (!service || !/^    environment:\n/m.test(service)) throw new Error('Unsupported Tinyauth Compose layout');
	updated = updated.replace(service, service.replace('    environment:\n', `    environment:\n${block}`));
	authEnvironment(updated);
	return updated;
}

export function syncAccess(options, services = {}) {
	const protectedServices = Object.values(services).some((service) => labelsOf(service).some((label) => /\.middlewares=/.test(label) && hasTinyauth(label.split('=').slice(1).join('='))));
	if (!fs.existsSync(authPath)) {
		if (protectedServices || hasTinyauth(options.authMiddleware)) throw new Error('Tinyauth Compose configuration is missing');
		return false;
	}
	const text = fs.readFileSync(authPath, 'utf8');
	const env = authEnvironment(text);
	const allowlist = options.cleanup ? null : hasTinyauth(options.authMiddleware) ? adminAllow : inheritedAllowlist(services, env);
	fs.writeFileSync(authPath, updateAccess(text, { ...options, allowlist }));
	return true;
}
