import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import yaml from 'js-yaml';

type ComposeService = {
	image?: unknown;
};

type ComposeDocument = {
	services?: Record<string, ComposeService>;
};

type UpdateComposeImageTagOptions = {
	serviceName: string;
	repo: string;
	tag: string;
	digest: string;
};

type UpdateComposeImageTagResult =
	| {
			changed: true;
			content: string;
			image: string;
			previousImage: string;
	  }
	| {
			changed: false;
			content: string;
			image: string;
			reason: string;
	  };

type UpdateTagArgs = {
	'app-path'?: string;
	'service-name'?: string;
	tag?: string;
	repo?: string;
	digest?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireArg(args: UpdateTagArgs, key: keyof UpdateTagArgs): string {
	const value = args[key];
	if (!value) throw new Error(`Missing required arg: --${key}`);
	return value;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function imageRepository(image: string): string {
	const withoutDigest = image.split('@')[0];
	const lastSlash = withoutDigest.lastIndexOf('/');
	const tagIndex = withoutDigest.indexOf(':', lastSlash + 1);
	return tagIndex === -1 ? withoutDigest : withoutDigest.slice(0, tagIndex);
}

function replaceServiceImageLine(content: string, serviceName: string, image: string): string {
	const lines = content.split('\n');
	const servicesLine = lines.findIndex((line) => /^(\s*)services:\s*(?:#.*)?$/.test(line));
	if (servicesLine === -1) {
		throw new Error('docker-compose.yml must contain a services block');
	}

	const servicesIndent = lines[servicesLine].match(/^(\s*)/)?.[1].length ?? 0;
	const servicePattern = new RegExp(`^(\\s*)${escapeRegExp(serviceName)}:\\s*(?:#.*)?$`);
	let serviceLine = -1;
	let serviceIndent = -1;

	for (let i = servicesLine + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		if (indent <= servicesIndent) break;

		const match = line.match(servicePattern);
		if (match) {
			serviceLine = i;
			serviceIndent = match[1].length;
			break;
		}
	}

	if (serviceLine === -1) {
		throw new Error(`Service "${serviceName}" not found in docker-compose.yml`);
	}

	for (let i = serviceLine + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '') continue;
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		if (indent <= serviceIndent) break;
		if (/^\s*image:\s*/.test(line)) {
			lines[i] = `${line.match(/^(\s*)/)?.[1] ?? ''}image: ${image}`;
			return lines.join('\n');
		}
	}

	throw new Error(`Service "${serviceName}" must define an image`);
}

export function updateComposeImageTag(
	content: string,
	{ serviceName, repo, tag, digest }: UpdateComposeImageTagOptions,
): UpdateComposeImageTagResult {
	const doc = yaml.load(content) as ComposeDocument;
	if (!isObject(doc) || !isObject(doc.services)) {
		throw new Error('docker-compose.yml must contain a services block');
	}

	const service = doc.services[serviceName];
	if (!isObject(service)) {
		throw new Error(`Service "${serviceName}" not found in docker-compose.yml`);
	}
	if (typeof service.image !== 'string') {
		throw new Error(`Service "${serviceName}" must define an image`);
	}

	const repoName = imageRepository(service.image);
	const expectedRepo = `ghcr.io/${repo}`.toLowerCase();
	if (repoName.toLowerCase() !== expectedRepo) {
		return {
			changed: false,
			content,
			image: service.image,
			reason: `service image is ${repoName}, expected ${expectedRepo}`,
		};
	}

	const nextImage = `${repoName}:${tag}@${digest}`;
	if (service.image === nextImage) {
		return { changed: false, content, image: service.image, reason: `already at ${nextImage}` };
	}

	return {
		changed: true,
		content: replaceServiceImageLine(content, serviceName, nextImage),
		image: nextImage,
		previousImage: service.image,
	};
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			'app-path': { type: 'string' },
			'service-name': { type: 'string' },
			tag: { type: 'string' },
			repo: { type: 'string' },
			digest: { type: 'string' },
		},
	});
	const args = values as UpdateTagArgs;
	const appPath = requireArg(args, 'app-path');
	const serviceName = requireArg(args, 'service-name');
	const tag = requireArg(args, 'tag');
	const repo = requireArg(args, 'repo');
	const digest = requireArg(args, 'digest');
	const composePath = path.join(appPath, 'docker-compose.yml');
	const content = fs.readFileSync(composePath, 'utf8');
	const result = updateComposeImageTag(content, { serviceName, repo, tag, digest });

	if (!result.changed) {
		console.log(`No changes - ${result.reason}`);
		return;
	}

	fs.writeFileSync(composePath, result.content);
	console.log(`Updated ${serviceName} to ${result.image} in ${composePath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}
