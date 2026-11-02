import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import yaml from 'js-yaml';
import { createHash } from 'node:crypto';

const REGEX_TINYAUTH_SERVICE = /^  tinyauth:\n(?:(?: {4}.*|\s*)\n)*/m;
const REGEX_ROUTER_MIDDLEWARES =
	/^traefik\.http\.routers\.([^.]+)\.middlewares=(.*)$/;
const REGEX_HOST = /Host\(`([^`]+)`\)/g;
const REGEX_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const REGEX_ROUTER = /^traefik\.http\.routers\.([^.]+)\./;
const REGEX_SERVICE = /^traefik\.http\.services\.([^.]+)\./;
const REGEX_PR_NUMBER = /^[1-9][0-9]*$/;
const REGEX_APP_NAME = /^[a-z0-9][a-z0-9.-]*$/;

const AUTH_MIDDLEWARES = Object.freeze({
	'tinyauth@file': true,
	'tinyauth-no-ratelimit@file': true,
});

export const AUTH_PATH = 'apps/tinyauth/docker-compose.yml';
export const ADMIN_ALLOW = '${TINYAUTH_ADMIN_ALLOW:?required}';
export const USERS_ALLOW = '${TINYAUTH_USERS_ALLOW:?required}';

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
	if (
		(domain || hasRule) &&
		!domain?.startsWith(`${domainKey}${previewHost}`)
	) {
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
	const service = updated.match(REGEX_TINYAUTH_SERVICE)?.[0];
	if (!service?.includes('    environment:\n')) {
		throw new Error('Unsupported Tinyauth Compose layout');
	}
	return updated.replace(
		service,
		service.replace('    environment:\n', `    environment:\n${rule}`),
	);
}

function validatePreviewTarget(appPath, prNumber) {
	if (typeof appPath !== 'string' || appPath.trim() === '') {
		throw new Error('app-path must be an app directory');
	}
	const directory = path.resolve(appPath);
	if (
		path.basename(path.dirname(directory)) !== 'apps' ||
		!REGEX_APP_NAME.test(path.basename(directory))
	) {
		throw new Error('app-path must name a directory directly under apps/');
	}
	if (!REGEX_PR_NUMBER.test(prNumber ?? '')) {
		throw new Error('pr-number must be a positive integer');
	}
	return directory;
}

export function removePreview(appPath, prNumber) {
	const directory = validatePreviewTarget(appPath, prNumber);
	const tempPath = `${directory}-pr-${prNumber}`;
	if (fs.existsSync(AUTH_PATH)) {
		const text = fs.readFileSync(AUTH_PATH, 'utf8');
		fs.writeFileSync(
			AUTH_PATH,
			updateAccess(text, { appPath: directory, prNumber, allowlist: null }),
		);
	}

	if (!fs.existsSync(tempPath)) {
		console.log(`Temp stack ${tempPath} does not exist, nothing to clean up`);
		return;
	}

	fs.rmSync(tempPath, { recursive: true });
	console.log(`Removed temp stack at ${tempPath}`);
}

export function serviceLabels(service) {
	if (Array.isArray(service.labels)) {
		return [...service.labels];
	}
	const labels = [];
	for (const [key, value] of Object.entries(service.labels ?? {})) {
		labels.push(`${key}=${value}`);
	}
	return labels;
}

export function hasTinyauth(middlewares = '') {
	for (const middleware of middlewares.split(',')) {
		if (Object.hasOwn(AUTH_MIDDLEWARES, middleware.trim())) {
			return true;
		}
	}
	return false;
}

export function tinyauthRules(services) {
	const rules = [];
	for (const service of Object.values(services ?? {})) {
		const labels = serviceLabels(service).filter(
			(label) => !label.includes('redirect'),
		);
		for (const label of labels) {
			const router = label.match(REGEX_ROUTER_MIDDLEWARES);
			if (router && hasTinyauth(router[2])) {
				rules.push(
					labels.find((value) =>
						value.startsWith(`traefik.http.routers.${router[1]}.rule=`),
					) ?? '',
				);
			}
		}
	}
	return rules;
}

export function isTinyauthPreview(tempPath) {
	const doc = yaml.load(
		fs.readFileSync(path.join(tempPath, 'docker-compose.yml'), 'utf8'),
	);
	return tinyauthRules(doc.services).length > 0;
}

export function parseAuthEnvironment(text) {
	const doc = yaml.load(text);
	const env = doc?.services?.tinyauth?.environment;
	if (!env || Array.isArray(env) || typeof env !== 'object') {
		throw new Error('Tinyauth requires a mapping environment');
	}
	if (env.TINYAUTH_AUTH_ACLS_POLICY !== 'deny') {
		throw new Error('Tinyauth must deny unknown domains');
	}
	if (doc['x-docker-cd']?.rolling_update !== false) {
		throw new Error(
			'Tinyauth must use rolling_update: false for environment recreation',
		);
	}
	return env;
}

// One preview hostname cannot represent two different access policies safely.
export function resolveInheritedAllowlist(rules, env) {
	const allowlists = new Set();
	for (const rule of rules) {
		const routerHosts = [...rule.matchAll(REGEX_HOST)];
		if (!routerHosts.length) {
			throw new Error('Protected router has no exact Host rule');
		}
		for (const [, host] of routerHosts) {
			const keys = Object.keys(env).filter((key) => {
				return key.endsWith('_CONFIG_DOMAIN') && env[key] === host;
			});
			if (keys.length !== 1) {
				throw new Error(`Expected one Tinyauth rule for ${host}`);
			}
			const allowlist =
				env[keys[0].replace('CONFIG_DOMAIN', 'OAUTH_WHITELIST')];
			if (![ADMIN_ALLOW, USERS_ALLOW].includes(allowlist)) {
				throw new Error(`Unsupported Tinyauth allowlist for ${host}`);
			}
			allowlists.add(allowlist);
		}
	}
	if (allowlists.size > 1) {
		throw new Error('Preview routers have different Tinyauth allowlists');
	}
	return [...allowlists][0] ?? null;
}

export function syncAccess(options, rules = []) {
	const middleware = options.authMiddleware?.trim();
	let protectedServices = rules.length > 0;
	if (middleware) {
		protectedServices = hasTinyauth(middleware);
	}
	if (!fs.existsSync(AUTH_PATH)) {
		if (protectedServices) {
			throw new Error('Tinyauth Compose configuration is missing');
		}
		return;
	}
	const text = fs.readFileSync(AUTH_PATH, 'utf8');
	const env = parseAuthEnvironment(text);
	let allowlist = null;
	if (protectedServices && middleware) {
		allowlist = ADMIN_ALLOW;
	} else if (protectedServices) {
		allowlist = resolveInheritedAllowlist(rules, env);
	}
	const prefix = `TINYAUTH_APPS_${previewId(options.appPath, options.prNumber)}_`;
	if (
		allowlist &&
		Object.entries(env).some(
			([key, value]) =>
				key.endsWith('_CONFIG_DOMAIN') &&
				!key.startsWith(prefix) &&
				value === options.hostname,
		)
	) {
		throw new Error('Preview hostname already belongs to another rule');
	}
	fs.writeFileSync(AUTH_PATH, updateAccess(text, { ...options, allowlist }));
}

export function hosts(services) {
	const allHosts = [];
	for (const [, service] of Object.entries(services)) {
		if (!service.labels) {
			continue;
		}
		for (const label of serviceLabels(service)) {
			for (const match of label.matchAll(REGEX_HOST)) {
				if (!allHosts.includes(match[1])) {
					allHosts.push(match[1]);
				}
			}
		}
	}
	return allHosts;
}

export function primaryHost(services) {
	const allHosts = hosts(services);
	return (
		allHosts.find((h) => h.split('.').length >= 3 && !h.startsWith('www.')) ??
		allHosts.find((h) => h.split('.').length >= 3) ??
		allHosts[0] ??
		null
	);
}

export function serviceDependencies(service) {
	const dependsOn = service?.depends_on;
	if (Array.isArray(dependsOn)) {
		return dependsOn.filter((name) => typeof name === 'string');
	}
	if (dependsOn != null && typeof dependsOn === 'object') {
		return Object.keys(dependsOn);
	}
	return [];
}

export function requiredServices(services, rootService) {
	if (!services || !Object.hasOwn(services, rootService)) {
		return new Set();
	}

	const selected = new Set([rootService]);
	const pending = [rootService];

	while (pending.length > 0) {
		const serviceName = pending.pop();
		for (const dependency of serviceDependencies(services[serviceName])) {
			if (!Object.hasOwn(services, dependency) || selected.has(dependency)) {
				continue;
			}
			selected.add(dependency);
			pending.push(dependency);
		}
	}

	return selected;
}

function serviceNetworkNames(service) {
	if (Array.isArray(service.networks)) {
		return service.networks.filter((name) => typeof name === 'string');
	}
	if (service.networks && typeof service.networks === 'object') {
		return Object.keys(service.networks);
	}
	return [];
}

function namedVolumeFromString(volume) {
	const [source] = volume.split(':');
	if (!source || path.isAbsolute(source) || source.startsWith('.')) {
		return null;
	}
	if (!REGEX_VOLUME_NAME.test(source)) {
		return null;
	}
	return source;
}

function pruneNetworks(doc, messages) {
	if (!doc.networks) {
		return;
	}

	const usedNetworks = new Set();
	for (const service of Object.values(doc.services)) {
		for (const networkName of serviceNetworkNames(service)) {
			usedNetworks.add(networkName);
		}
	}

	for (const networkName of Object.keys(doc.networks)) {
		if (!usedNetworks.has(networkName)) {
			delete doc.networks[networkName];
			messages.push(`Removed unused network: ${networkName}`);
		}
	}

	if (Object.keys(doc.networks).length === 0) {
		delete doc.networks;
	}
}

function pruneVolumes(doc, volumeNames, messages) {
	if (!doc.volumes) {
		return;
	}

	for (const volumeName of Object.keys(doc.volumes)) {
		if (!volumeNames.has(volumeName)) {
			delete doc.volumes[volumeName];
			messages.push(`Removed unused volume: ${volumeName}`);
		}
	}

	if (Object.keys(doc.volumes).length === 0) {
		delete doc.volumes;
	}
}

function routerMiddlewareLabels(labels, authMiddleware) {
	const middleware = authMiddleware?.trim();
	if (!middleware) {
		return labels;
	}

	const routerNames = new Set();
	const routersWithMiddleware = new Set();

	const rewritten = [];
	for (const label of labels) {
		const router = label.match(REGEX_ROUTER)?.[1];
		if (!router) {
			rewritten.push(label);
			continue;
		}
		routerNames.add(router);
		if (!label.startsWith(`traefik.http.routers.${router}.middlewares=`)) {
			rewritten.push(label);
			continue;
		}
		routersWithMiddleware.add(router);
		rewritten.push(`traefik.http.routers.${router}.middlewares=${middleware}`);
	}

	for (const router of routerNames) {
		if (!routersWithMiddleware.has(router)) {
			rewritten.push(
				`traefik.http.routers.${router}.middlewares=${middleware}`,
			);
		}
	}

	return rewritten;
}

function tempTraefikName(name, serviceName, prNumber) {
	const tempName = `${serviceName}-pr-${prNumber}`;
	if (name === serviceName) {
		return tempName;
	}
	if (name.startsWith(`${serviceName}-`)) {
		return `${tempName}${name.slice(serviceName.length)}`;
	}
	return `${name}-pr-${prNumber}`;
}

function previewTraefikLabel(label, serviceName, prNumber) {
	return label
		.replace(
			REGEX_ROUTER,
			(_, name) =>
				`traefik.http.routers.${tempTraefikName(name, serviceName, prNumber)}.`,
		)
		.replace(
			REGEX_SERVICE,
			(_, name) =>
				`traefik.http.services.${tempTraefikName(name, serviceName, prNumber)}.`,
		);
}

export function rewriteComposeForPreview(doc, options) {
	if (
		doc?.services == null ||
		typeof doc.services !== 'object' ||
		Array.isArray(doc.services)
	) {
		throw new Error('Compose must define a services mapping');
	}
	const { appName, serviceName, tag, prNumber, repoOwner, authMiddleware } =
		options;
	const rewritten = structuredClone(doc);
	const messages = [];

	const selectedServices = requiredServices(rewritten.services, serviceName);
	if (selectedServices.size === 0) {
		throw new Error(`Could not find app service "${serviceName}"`);
	}

	for (const currentServiceName of Object.keys(rewritten.services)) {
		if (!selectedServices.has(currentServiceName)) {
			delete rewritten.services[currentServiceName];
			messages.push(`Removed unrelated service: ${currentServiceName}`);
		}
	}

	const authRules = tinyauthRules(rewritten.services);
	const originalHost = primaryHost(rewritten.services);
	if (!originalHost) {
		throw new Error('Could not detect domain from traefik Host() labels');
	}

	const domain = originalHost.split('.').slice(1).join('.');
	const hostname = `pr-${prNumber}-${appName}.${domain}`;
	const volumeNames = new Set();

	for (const service of Object.values(rewritten.services)) {
		if (service.container_name) {
			delete service.container_name;
		}

		if (service.image?.startsWith(`ghcr.io/${repoOwner}/`)) {
			const imageName = service.image.split(':')[0];
			service.image = `${imageName}:${tag}`;
		}

		if (service.labels) {
			const labels = [];
			for (const label of serviceLabels(service)) {
				if (label.includes('redirect')) {
					continue;
				}
				labels.push(
					previewTraefikLabel(label, serviceName, prNumber).replace(
						REGEX_HOST,
						`Host(\`${hostname}\`)`,
					),
				);
			}
			service.labels = routerMiddlewareLabels(labels, authMiddleware);
		}

		if (service.volumes) {
			const volumes = [];
			for (const volume of service.volumes) {
				if (typeof volume !== 'string') {
					if (volume?.type === 'volume' && typeof volume.source === 'string') {
						volumeNames.add(volume.source);
					}
					volumes.push(volume);
					continue;
				}
				const [hostPath, ...rest] = volume.split(':');
				if (!path.isAbsolute(hostPath)) {
					const volumeName = namedVolumeFromString(volume);
					if (volumeName) {
						volumeNames.add(volumeName);
					}
					volumes.push(volume);
					continue;
				}
				const basename = path.basename(hostPath);
				const volumeName = basename === '' ? 'data' : basename;
				volumeNames.add(volumeName);
				volumes.push(`${volumeName}:${rest.join(':')}`);
			}
			service.volumes = volumes;
		}
	}

	pruneNetworks(rewritten, messages);
	pruneVolumes(rewritten, volumeNames, messages);

	if (volumeNames.size > 0) {
		rewritten.volumes = rewritten.volumes ?? {};
		for (const name of volumeNames) {
			rewritten.volumes[name] = null;
		}
	}

	return {
		doc: rewritten,
		authRules,
		hostname,
		url: `https://${hostname}`,
		messages,
	};
}

export async function main(argv = process.argv.slice(2)) {
	const { values: args } = parseArgs({
		args: argv,
		options: {
			action: { type: 'string' },
			'app-path': { type: 'string' },
			'service-name': { type: 'string' },
			tag: { type: 'string' },
			'pr-number': { type: 'string' },
			'repo-owner': { type: 'string' },
			'app-repo-path': { type: 'string' },
			'auth-middleware': { type: 'string' },
		},
	});
	if (!['create', 'cleanup'].includes(args.action)) {
		throw new Error('--action must be create or cleanup');
	}
	for (const key of ['app-path', 'pr-number']) {
		if (!args[key]) {
			throw new Error(`Missing required arg: --${key}`);
		}
	}
	if (args.action === 'cleanup') {
		removePreview(args['app-path'], args['pr-number']);
		return;
	}
	for (const key of ['service-name', 'tag', 'repo-owner']) {
		if (!args[key]) {
			throw new Error(`Missing required arg: --${key}`);
		}
	}
	const appRepoPath = args['app-repo-path'];
	const appPath = validatePreviewTarget(args['app-path'], args['pr-number']);
	const serviceName = args['service-name'];
	const tag = args['tag'];
	const prNumber = args['pr-number'];
	const repoOwner = args['repo-owner'];
	const authMiddleware = args['auth-middleware'];
	const appName = path.basename(appPath);
	const tempPath = `${appPath}-pr-${prNumber}`;

	fs.rmSync(tempPath, { recursive: true, force: true });
	fs.cpSync(appPath, tempPath, { recursive: true });

	if (appRepoPath) {
		const appRepoSops = path.join(appRepoPath, '.env.sops');
		if (fs.existsSync(appRepoSops)) {
			fs.cpSync(appRepoSops, path.join(tempPath, '.env.sops.override'));
			console.log('Copied .env.sops from app repo as .env.sops.override');
		}
	}

	const composePath = path.join(tempPath, 'docker-compose.yml');
	const doc = yaml.load(fs.readFileSync(composePath, 'utf8'));
	const result = rewriteComposeForPreview(doc, {
		appName,
		serviceName,
		tag,
		prNumber,
		repoOwner,
		authMiddleware,
	});
	syncAccess(
		{ appPath, prNumber, hostname: result.hostname, authMiddleware },
		result.authRules,
	);
	for (const message of result.messages) {
		console.log(message);
	}

	const composeDoc = { ...result.doc };
	delete composeDoc['x-docker-cd'];
	const tempComposeDoc = {
		'x-docker-cd': {
			rolling_update: false,
		},
		...composeDoc,
	};

	fs.writeFileSync(
		composePath,
		yaml.dump(tempComposeDoc, {
			lineWidth: -1,
			quotingType: '"',
			forceQuotes: false,
		}),
	);

	console.log(`Created temp stack at ${tempPath}`);
	console.log(`URL: ${result.url}`);

	const outputFile = process.env.GITHUB_OUTPUT;
	if (outputFile) {
		fs.appendFileSync(outputFile, `url=${result.url}\n`);
		fs.appendFileSync(outputFile, `temp-path=${tempPath}\n`);
	}
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	main().catch(function (err) {
		console.error(err.message);
		process.exit(1);
	});
}
