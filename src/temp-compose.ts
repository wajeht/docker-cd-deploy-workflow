import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import yaml from 'js-yaml';

type ComposeVolumeObject = Record<string, unknown> & {
	type?: unknown;
	source?: unknown;
};

type ComposeVolume = string | ComposeVolumeObject | null;

export type ComposeService = Record<string, unknown> & {
	labels?: string[];
	depends_on?: string[] | Record<string, unknown>;
	networks?: string[] | Record<string, unknown>;
	container_name?: unknown;
	image?: string;
	volumes?: ComposeVolume[];
};

export type ComposeDocument = Record<string, unknown> & {
	services: Record<string, ComposeService>;
	networks?: Record<string, unknown>;
	volumes?: Record<string, unknown>;
};

type RewriteTempDeployOptions = {
	appName: string;
	serviceName: string;
	tag: string;
	prNumber: string;
	repoOwner: string;
	authMiddleware?: string;
};

type RewriteTempDeployResult = {
	doc: ComposeDocument;
	hostname: string;
	url: string;
	messages: string[];
};

type TempComposeArgs = {
	'app-path'?: string;
	'service-name'?: string;
	tag?: string;
	'pr-number'?: string;
	'repo-owner'?: string;
	'app-repo-path'?: string;
	'auth-middleware'?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isComposeDocument(value: unknown): value is ComposeDocument {
	return isObject(value) && isObject(value.services);
}

function requireArg(args: TempComposeArgs, key: keyof TempComposeArgs): string {
	const value = args[key];
	if (!value) throw new Error(`Missing required arg: --${key}`);
	return value;
}

export function collectHosts(services: Record<string, ComposeService>): string[] {
	const allHosts: string[] = [];
	for (const [, service] of Object.entries(services)) {
		if (!service.labels) continue;
		for (const label of service.labels) {
			for (const match of label.matchAll(/Host\(`([^`]+)`\)/g)) {
				if (!allHosts.includes(match[1])) allHosts.push(match[1]);
			}
		}
	}
	return allHosts;
}

export function detectHost(services: Record<string, ComposeService>): string | null {
	const allHosts = collectHosts(services);
	return allHosts.find((h) => h.split('.').length >= 3 && !h.startsWith('www.')) || allHosts.find((h) => h.split('.').length >= 3) || allHosts[0] || null;
}

export function dependsOnServices(service?: ComposeService): string[] {
	const dependsOn = service?.depends_on;
	if (Array.isArray(dependsOn)) {
		return dependsOn.filter((name) => typeof name === 'string');
	}
	if (dependsOn && typeof dependsOn === 'object') {
		return Object.keys(dependsOn);
	}
	return [];
}

export function dependentServices(services: Record<string, ComposeService> | undefined, rootService: string): Set<string> {
	if (!services || !Object.hasOwn(services, rootService)) {
		return new Set();
	}

	const selected = new Set([rootService]);
	const pending = [rootService];

	while (pending.length > 0) {
		const serviceName = pending.pop();
		if (!serviceName) continue;
		for (const dependency of dependsOnServices(services[serviceName])) {
			if (!Object.hasOwn(services, dependency) || selected.has(dependency)) {
				continue;
			}
			selected.add(dependency);
			pending.push(dependency);
		}
	}

	return selected;
}

function serviceNetworkNames(service: ComposeService): string[] {
	if (Array.isArray(service.networks)) {
		return service.networks.filter((name) => typeof name === 'string');
	}
	if (service.networks && typeof service.networks === 'object') {
		return Object.keys(service.networks);
	}
	return [];
}

function namedVolumeFromString(volume: string): string | null {
	const [source] = volume.split(':');
	if (!source || path.isAbsolute(source) || source.startsWith('.')) {
		return null;
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source)) {
		return null;
	}
	return source;
}

function pruneNetworks(doc: ComposeDocument, messages: string[]): void {
	if (!doc.networks) return;

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

function pruneVolumes(doc: ComposeDocument, volumeNames: Set<string>, messages: string[]): void {
	if (!doc.volumes) return;

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

function applyAuthMiddleware(labels: string[], authMiddleware?: string): string[] {
	const middleware = authMiddleware?.trim();
	if (!middleware) return labels;

	const routerNames = new Set();
	const routersWithMiddleware = new Set();

	const rewritten = labels.map((label) => {
		const router = label.match(/^traefik\.http\.routers\.([^.]+)\./)?.[1];
		if (!router) return label;

		routerNames.add(router);
		if (!label.startsWith(`traefik.http.routers.${router}.middlewares=`)) {
			return label;
		}

		routersWithMiddleware.add(router);
		return `traefik.http.routers.${router}.middlewares=${middleware}`;
	});

	for (const router of routerNames) {
		if (!routersWithMiddleware.has(router)) {
			rewritten.push(`traefik.http.routers.${router}.middlewares=${middleware}`);
		}
	}

	return rewritten;
}

function tempTraefikName(name: string, serviceName: string, prNumber: string): string {
	const tempName = `${serviceName}-pr-${prNumber}`;
	if (name === serviceName) return tempName;
	if (name.startsWith(`${serviceName}-`)) return `${tempName}${name.slice(serviceName.length)}`;
	return `${name}-pr-${prNumber}`;
}

function rewriteTraefikLabel(label: string, serviceName: string, prNumber: string): string {
	return label
		.replace(/^traefik\.http\.routers\.([^.]+)\./, (_match, name: string) => `traefik.http.routers.${tempTraefikName(name, serviceName, prNumber)}.`)
		.replace(/^traefik\.http\.services\.([^.]+)\./, (_match, name: string) => `traefik.http.services.${tempTraefikName(name, serviceName, prNumber)}.`);
}

export function rewriteComposeForTempDeploy(doc: ComposeDocument, options: RewriteTempDeployOptions): RewriteTempDeployResult {
	const { appName, serviceName, tag, prNumber, repoOwner, authMiddleware } = options;
	const rewritten = structuredClone(doc);
	const messages = [];

	const selectedServices = dependentServices(rewritten.services, serviceName);
	if (selectedServices.size === 0) {
		throw new Error(`Could not find app service "${serviceName}"`);
	}

	for (const currentServiceName of Object.keys(rewritten.services)) {
		if (!selectedServices.has(currentServiceName)) {
			delete rewritten.services[currentServiceName];
			messages.push(`Removed unrelated service: ${currentServiceName}`);
		}
	}

	const originalHost = detectHost(rewritten.services);
	if (!originalHost) {
		throw new Error('Could not detect domain from traefik Host() labels');
	}

	const domain = originalHost.split('.').slice(1).join('.');
	const hostname = `pr-${prNumber}-${appName}.${domain}`;
	const volumeNames = new Set<string>();

	for (const service of Object.values(rewritten.services)) {
		if (service.container_name) {
			delete service.container_name;
		}

		if (service.image?.startsWith(`ghcr.io/${repoOwner}/`)) {
			const imageName = service.image.split(':')[0];
			service.image = `${imageName}:${tag}`;
		}

		if (service.labels) {
			const labels = service.labels
				.filter((label) => !label.includes('redirect'))
				.map((label) =>
					rewriteTraefikLabel(label, serviceName, prNumber).replace(/Host\(`[^`]+`\)/g, `Host(\`${hostname}\`)`),
				);
			service.labels = applyAuthMiddleware(labels, authMiddleware);
		}

		if (service.volumes) {
			service.volumes = service.volumes.map((vol) => {
				if (typeof vol !== 'string') {
					if (vol?.type === 'volume' && typeof vol.source === 'string') {
						volumeNames.add(vol.source);
					}
					return vol;
				}

				const [hostPath, ...rest] = vol.split(':');
				const containerPath = rest.join(':');

				if (!path.isAbsolute(hostPath)) {
					const volumeName = namedVolumeFromString(vol);
					if (volumeName) volumeNames.add(volumeName);
					return vol;
				}

				const volName = hostPath.split('/').filter(Boolean).pop() || 'data';
				volumeNames.add(volName);
				return `${volName}:${containerPath}`;
			});
		}
	}

	pruneNetworks(rewritten, messages);
	pruneVolumes(rewritten, volumeNames, messages);

	if (volumeNames.size > 0) {
		rewritten.volumes = rewritten.volumes || {};
		for (const name of volumeNames) {
			rewritten.volumes[name] = null;
		}
	}

	return { doc: rewritten, hostname, url: `https://${hostname}`, messages };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			'app-path': { type: 'string' },
			'service-name': { type: 'string' },
			tag: { type: 'string' },
			'pr-number': { type: 'string' },
			'repo-owner': { type: 'string' },
			'app-repo-path': { type: 'string' },
			'auth-middleware': { type: 'string' },
		},
	});
	const args = values as TempComposeArgs;
	const appRepoPath = args['app-repo-path'];
	const appPath = requireArg(args, 'app-path');
	const serviceName = requireArg(args, 'service-name');
	const tag = requireArg(args, 'tag');
	const prNumber = requireArg(args, 'pr-number');
	const repoOwner = requireArg(args, 'repo-owner');
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
	if (!isComposeDocument(doc)) {
		throw new Error('docker-compose.yml must contain a services block');
	}
	const result = rewriteComposeForTempDeploy(doc, { appName, serviceName, tag, prNumber, repoOwner, authMiddleware });
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

	fs.writeFileSync(composePath, yaml.dump(tempComposeDoc, { lineWidth: -1, quotingType: '"', forceQuotes: false }));

	console.log(`Created temp stack at ${tempPath}`);
	console.log(`URL: ${result.url}`);
	console.log('--- docker-compose.yml ---');
	console.log(fs.readFileSync(composePath, 'utf8'));

	const outputFile = process.env.GITHUB_OUTPUT;
	if (outputFile) {
		fs.appendFileSync(outputFile, `url=${result.url}\n`);
		fs.appendFileSync(outputFile, `temp-path=${tempPath}\n`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}
