import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import yaml from 'js-yaml';

export function collectHosts(services) {
	const allHosts = [];
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

export function detectHost(services) {
	const allHosts = collectHosts(services);
	return allHosts.find((h) => h.split('.').length >= 3 && !h.startsWith('www.')) || allHosts.find((h) => h.split('.').length >= 3) || allHosts[0] || null;
}

export function dependsOnServices(service) {
	const dependsOn = service?.depends_on;
	if (Array.isArray(dependsOn)) {
		return dependsOn.filter((name) => typeof name === 'string');
	}
	if (dependsOn && typeof dependsOn === 'object') {
		return Object.keys(dependsOn);
	}
	return [];
}

export function dependentServices(services, rootService) {
	if (!services || !Object.hasOwn(services, rootService)) {
		return new Set();
	}

	const selected = new Set([rootService]);
	const pending = [rootService];

	while (pending.length > 0) {
		const serviceName = pending.pop();
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
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source)) {
		return null;
	}
	return source;
}

function pruneNetworks(doc, messages) {
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

function pruneVolumes(doc, volumeNames, messages) {
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

export function rewriteComposeForTempDeploy(doc, options) {
	const { appName, serviceName, tag, prNumber, repoOwner } = options;
	const rewritten = structuredClone(doc);
	const messages = [];
	const tempName = `${serviceName}-pr-${prNumber}`;

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
			service.labels = service.labels
				.filter((label) => !label.includes('redirect'))
				.map((label) =>
					label
						.replaceAll(`traefik.http.routers.${serviceName}`, `traefik.http.routers.${tempName}`)
						.replaceAll(`traefik.http.services.${serviceName}`, `traefik.http.services.${tempName}`)
						.replace(/Host\(`[^`]+`\)/g, `Host(\`${hostname}\`)`),
				);
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

export async function main(argv = process.argv.slice(2)) {
	const { values: args } = parseArgs({
		args: argv,
		options: {
			'app-path': { type: 'string' },
			'service-name': { type: 'string' },
			tag: { type: 'string' },
			'pr-number': { type: 'string' },
			'repo-owner': { type: 'string' },
			'app-repo-path': { type: 'string' },
		},
	});
	for (const key of ['app-path', 'service-name', 'tag', 'pr-number', 'repo-owner']) {
		if (!args[key]) throw new Error(`Missing required arg: --${key}`);
	}
	const appRepoPath = args['app-repo-path'];
	const appPath = args['app-path'];
	const serviceName = args['service-name'];
	const tag = args['tag'];
	const prNumber = args['pr-number'];
	const repoOwner = args['repo-owner'];
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
	const result = rewriteComposeForTempDeploy(doc, { appName, serviceName, tag, prNumber, repoOwner });
	for (const message of result.messages) {
		console.log(message);
	}

	fs.writeFileSync(composePath, yaml.dump(result.doc, { lineWidth: -1, quotingType: '"', forceQuotes: false }));
	fs.writeFileSync(path.join(tempPath, 'docker-cd.yml'), 'rolling_update: false\n');

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
