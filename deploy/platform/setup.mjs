#!/usr/bin/env node
// Fork tool (not in upstream n8n). Sets up the team projects, the SSO group rules and the team
// credentials of n8n from a config file, over the public API. README.md tells how to use it.
// It needs Node.js 22 or later, and no packages.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = `Usage: node setup.mjs <plan|apply|check> [--config <file>] [--prune-rules]

  plan    Show the changes that apply makes. Changes nothing.
  apply   Create the missing team projects, team credentials and SSO group rules,
          and put the rules in the order of the config.
  check   Check the setup and the security settings. Exits with 1 when a check fails.

Options:
  --config <file>   The config file. The default is platform.json next to this script.
  --prune-rules     Also delete the SSO group rules that are not in the config.

Environment:
  N8N_URL       The address of n8n, for example https://n8n.example.com
  N8N_API_KEY   An API key of the owner or of an admin, with the scopes in README.md`;

const PAGE_SIZE = 250;
const GLOBAL_ROLE = /^global:[a-z0-9_-]+$/i;
const PROJECT_ROLE = /^project:[a-z0-9_-]+$/i;
const CREDENTIAL_OWNER = 'credential:owner';

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// ── The config ────────────────────────────────────────────────────────────────

/** Gives the config with its defaults, and the list of its problems. */
export function readConfig(raw) {
	const problems = [];
	if (!isRecord(raw)) return { config: null, problems: ['The config must be a JSON object.'] };

	const groupsClaim = raw.groupsClaim ?? 'groups';
	if (typeof groupsClaim !== 'string' || groupsClaim.trim() === '') {
		problems.push('groupsClaim must be the name of a claim, for example "groups".');
	}

	const checkGroup = (group, where) => {
		if (typeof group !== 'string' || group.trim() === '') {
			problems.push(`${where}: group must be a text.`);
		} else if (group.includes('{{') || group.includes('}}')) {
			problems.push(`${where}: group must not contain {{ or }}.`);
		}
	};

	const instanceRoles = raw.instanceRoles ?? [];
	if (!Array.isArray(instanceRoles)) problems.push('instanceRoles must be a list.');
	const instanceGroups = new Set();
	for (const [index, entry] of (Array.isArray(instanceRoles) ? instanceRoles : []).entries()) {
		const where = `instanceRoles[${index}]`;
		if (!isRecord(entry)) {
			problems.push(`${where} must be an object with group and role.`);
			continue;
		}
		checkGroup(entry.group, where);
		if (typeof entry.role !== 'string' || !GLOBAL_ROLE.test(entry.role)) {
			problems.push(`${where}: role must be a global role, for example "global:member".`);
		} else if (entry.role === 'global:owner') {
			problems.push(`${where}: SSO cannot give the role global:owner.`);
		}
		if (instanceGroups.has(entry.group)) {
			problems.push(`${where}: the group "${entry.group}" is in instanceRoles twice.`);
		}
		instanceGroups.add(entry.group);
	}

	const defaultInstanceRole = raw.defaultInstanceRole;
	if (defaultInstanceRole === 'block:access') {
		problems.push(
			'defaultInstanceRole: block:access is not a role. Give the n8n application only to the groups of n8n in the identity provider.',
		);
	} else if (
		defaultInstanceRole !== undefined &&
		(typeof defaultInstanceRole !== 'string' ||
			!GLOBAL_ROLE.test(defaultInstanceRole) ||
			defaultInstanceRole === 'global:owner')
	) {
		problems.push('defaultInstanceRole must be a global role, for example "global:chatUser".');
	}

	const projects = raw.projects ?? [];
	if (!Array.isArray(projects)) problems.push('projects must be a list.');
	const projectNames = new Set();
	for (const [index, project] of (Array.isArray(projects) ? projects : []).entries()) {
		const where = `projects[${index}]`;
		if (!isRecord(project) || typeof project.name !== 'string' || project.name.trim() === '') {
			problems.push(`${where} must be an object with a name.`);
			continue;
		}
		if (projectNames.has(project.name)) {
			problems.push(`${where}: the project "${project.name}" is in the config twice.`);
		}
		projectNames.add(project.name);
		if (project.description !== undefined && typeof project.description !== 'string') {
			problems.push(`${where}: description must be a text.`);
		}

		const roles = project.roles ?? [];
		const projectGroups = new Set();
		if (!Array.isArray(roles)) problems.push(`${where}: roles must be a list.`);
		for (const [roleIndex, entry] of (Array.isArray(roles) ? roles : []).entries()) {
			const roleWhere = `${where}.roles[${roleIndex}]`;
			if (!isRecord(entry)) {
				problems.push(`${roleWhere} must be an object with group and role.`);
				continue;
			}
			checkGroup(entry.group, roleWhere);
			if (typeof entry.role !== 'string' || !PROJECT_ROLE.test(entry.role)) {
				problems.push(`${roleWhere}: role must be a project role, for example "project:editor".`);
			} else if (entry.role === 'project:personalOwner') {
				problems.push(`${roleWhere}: a team project has no role project:personalOwner.`);
			}
			if (projectGroups.has(entry.group)) {
				problems.push(`${roleWhere}: the group "${entry.group}" is in this project twice.`);
			}
			projectGroups.add(entry.group);
		}

		const credentials = project.credentials ?? [];
		const credentialNames = new Set();
		if (!Array.isArray(credentials)) problems.push(`${where}: credentials must be a list.`);
		for (const [credentialIndex, entry] of (Array.isArray(credentials)
			? credentials
			: []
		).entries()) {
			const credentialWhere = `${where}.credentials[${credentialIndex}]`;
			if (
				!isRecord(entry) ||
				typeof entry.name !== 'string' ||
				entry.name.trim() === '' ||
				typeof entry.type !== 'string' ||
				entry.type.trim() === '' ||
				!isRecord(entry.data)
			) {
				problems.push(`${credentialWhere} must be an object with a name, a type and data.`);
				continue;
			}
			if (credentialNames.has(entry.name)) {
				problems.push(
					`${credentialWhere}: the credential "${entry.name}" is in this project twice.`,
				);
			}
			credentialNames.add(entry.name);
		}
	}

	if (problems.length > 0) return { config: null, problems };
	return {
		config: {
			groupsClaim,
			instanceRoles,
			defaultInstanceRole,
			projects: projects.map((project) => ({
				name: project.name,
				description: project.description,
				roles: project.roles ?? [],
				credentials: project.credentials ?? [],
			})),
		},
		problems,
	};
}

/**
 * The expression of the rule for a group. It matches when the claim lists the group. A claim
 * with one value can come as a text, and `[].concat` turns it into a list.
 */
export function groupExpression(claim, group) {
	return `{{ [].concat($claims[${JSON.stringify(claim)}] || []).includes(${JSON.stringify(group)}) }}`;
}

/** The expression of the last instance rule, which gives the default role: it always matches. */
export const DEFAULT_RULE_EXPRESSION = '{{ true }}';

/**
 * Copies the data of a credential. An object `{ "env": "NAME" }` becomes the value of the
 * environment variable NAME. The names of the missing variables go to `missing`.
 */
export function resolveData(data, env, missing) {
	if (Array.isArray(data)) return data.map((value) => resolveData(value, env, missing));
	if (!isRecord(data)) return data;
	const keys = Object.keys(data);
	if (keys.length === 1 && keys[0] === 'env' && typeof data.env === 'string') {
		const value = env[data.env];
		if (value === undefined || value === '') {
			missing.push(data.env);
			return '';
		}
		return value;
	}
	return Object.fromEntries(
		Object.entries(data).map(([key, value]) => [key, resolveData(value, env, missing)]),
	);
}

/** The providers of external secrets that the data of a credential names. */
export function secretProviders(data) {
	const providers = new Set();
	const visit = (value) => {
		if (typeof value === 'string') {
			for (const match of value.matchAll(/\$secrets\.([A-Za-z0-9_-]+)/g)) providers.add(match[1]);
		} else if (Array.isArray(value)) {
			value.forEach(visit);
		} else if (isRecord(value)) {
			Object.values(value).forEach(visit);
		}
	};
	visit(data);
	return [...providers].sort();
}

// ── The public API ────────────────────────────────────────────────────────────

export class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

export function createClient(baseUrl, apiKey, fetchImpl = fetch) {
	const root = baseUrl.replace(/\/+$/, '');

	async function request(method, path, body, { auth = true } = {}) {
		const response = await fetchImpl(`${root}${path}`, {
			method,
			headers: {
				accept: 'application/json',
				...(auth && { 'x-n8n-api-key': apiKey }),
				...(body !== undefined && { 'content-type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let json = null;
		try {
			json = text === '' ? null : JSON.parse(text);
		} catch {
			json = null;
		}
		if (!response.ok) {
			const detail = isRecord(json) && typeof json.message === 'string' ? json.message : '';
			throw new ApiError(
				response.status,
				`${method} ${path.split('?')[0]} answered ${response.status}${detail ? `: ${detail}` : ''}`,
			);
		}
		return json;
	}

	const api = async (method, path, body) => await request(method, `/api/v1${path}`, body);

	async function listAll(path, query = {}) {
		const items = [];
		let cursor;
		do {
			const params = new URLSearchParams({ ...query, limit: String(PAGE_SIZE) });
			if (cursor) params.set('cursor', cursor);
			const page = await api('GET', `${path}?${params}`);
			items.push(...page.data);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		return items;
	}

	return { request, api, listAll };
}

// ── The plan ──────────────────────────────────────────────────────────────────

const ruleKey = (rule) =>
	[rule.type, rule.role, rule.expression, [...(rule.projectIds ?? [])].sort().join(',')].join('|');

const byOrder = (a, b) => a.order - b.order;

const hasOwner = (credential, projectId) =>
	credential.shared?.some((share) => share.id === projectId && share.role === CREDENTIAL_OWNER) ??
	false;

/** Reads the team projects, the credentials, the SSO group rules and the roles of n8n. */
export async function readState(client) {
	const [projects, credentials, rules, roles] = await Promise.all([
		client.listAll('/projects'),
		client.listAll('/credentials'),
		client.listAll('/role-mapping-rules'),
		client.api('GET', '/roles'),
	]);
	return {
		teamProjects: projects.filter((project) => project.type === 'team'),
		credentials,
		rules,
		roleSlugs: new Set([...(roles?.global ?? []), ...(roles?.project ?? [])].map((r) => r.slug)),
	};
}

/** The ids of the team projects of the config, and the names that two team projects have. */
function matchProjects(config, state) {
	const byName = new Map();
	const ambiguous = new Set();
	for (const project of state.teamProjects) {
		if (byName.has(project.name)) ambiguous.add(project.name);
		byName.set(project.name, project);
	}
	const ids = new Map();
	for (const { name } of config.projects) {
		if (byName.has(name) && !ambiguous.has(name)) ids.set(name, byName.get(name).id);
	}
	return { ids, ambiguous };
}

/**
 * The rules that the config asks for, for each type, in the order of the config. A project rule
 * of a project that does not exist yet has no `projectIds`.
 */
function wantedRules(config, projectIds) {
	const instance = config.instanceRoles.map(({ group, role }) => ({
		type: 'instance',
		role,
		expression: groupExpression(config.groupsClaim, group),
		projectIds: [],
		label: `${group} → ${role}`,
	}));
	if (config.defaultInstanceRole) {
		instance.push({
			type: 'instance',
			role: config.defaultInstanceRole,
			expression: DEFAULT_RULE_EXPRESSION,
			projectIds: [],
			label: `everyone else → ${config.defaultInstanceRole}`,
		});
	}
	const project = config.projects.flatMap((entry) =>
		entry.roles.map(({ group, role }) => ({
			type: 'project',
			role,
			expression: groupExpression(config.groupsClaim, group),
			projectIds: projectIds.has(entry.name) ? [projectIds.get(entry.name)] : null,
			label: `${group} → ${role} in ${entry.name}`,
		})),
	);
	return { instance, project };
}

/**
 * Pairs the wanted rules of a type with the rules of n8n. `matches[i]` is the rule of n8n for
 * `wanted[i]`, or undefined. A second copy of a rule counts as another rule.
 */
function pairRules(wanted, existing) {
	const used = new Set();
	const matches = wanted.map((rule) => {
		if (rule.projectIds === null) return undefined;
		const match = existing.find(
			(candidate) => !used.has(candidate.id) && ruleKey(candidate) === ruleKey(rule),
		);
		if (match) used.add(match.id);
		return match;
	});
	return { matches, others: existing.filter((rule) => !used.has(rule.id)) };
}

/** The label of a rule that is not in the config. */
function otherRuleLabel(rule, state) {
	const names = rule.projectIds.map(
		(id) => state.teamProjects.find((project) => project.id === id)?.name ?? id,
	);
	return `${rule.expression} → ${rule.role}${names.length ? ` in ${names.join(', ')}` : ''}`;
}

/**
 * The warnings about the rules after apply. When project rules exist, n8n gives an SSO user
 * exactly the team project roles of the rules at each sign-in, so a team project without a rule
 * loses its SSO members. A rule after the rule of the default role never matches.
 */
function ruleWarnings(config, state, ids, prune) {
	const warnings = [];
	const keptRules = prune
		? []
		: pairRules(
				wantedRules(config, ids).project,
				state.rules.filter((rule) => rule.type === 'project'),
			).others;
	const covered = new Set([
		...config.projects.filter((project) => project.roles.length > 0).map((project) => project.name),
		...keptRules.flatMap((rule) =>
			rule.projectIds.map((id) => state.teamProjects.find((project) => project.id === id)?.name),
		),
	]);
	if (covered.size > 0) {
		const names = new Set([
			...state.teamProjects.map((project) => project.name),
			...config.projects.map((project) => project.name),
		]);
		const uncovered = [...names].filter((name) => !covered.has(name)).sort();
		if (uncovered.length > 0) {
			warnings.push(
				`These team projects have no SSO group rule, so SSO users lose their roles in them at the next sign-in: ${uncovered.join(', ')}.`,
			);
		}
	}

	if (config.defaultInstanceRole && !prune) {
		const existing = state.rules.filter((rule) => rule.type === 'instance').sort(byOrder);
		const { others } = pairRules(wantedRules(config, ids).instance, existing);
		if (others.length > 0) {
			warnings.push(
				`These instance rules come after the rule of the default role, so they never match: ${others.map((rule) => otherRuleLabel(rule, state)).join('; ')}.`,
			);
		}
	}
	return warnings;
}

/**
 * Compares the config with n8n. Gives the steps of apply in three sections, the problems that
 * stop apply, and warnings. A step with `change: true` changes n8n.
 */
export async function plan(config, state, { env, prune = false, client }) {
	const problems = [];
	const sections = { projects: [], credentials: [], rules: [] };
	const { ids, ambiguous } = matchProjects(config, state);

	for (const { name } of config.projects) {
		if (ambiguous.has(name)) {
			problems.push(`Two team projects have the name "${name}". Rename one of them in n8n.`);
		} else if (ids.has(name)) {
			sections.projects.push({ action: 'exists', text: name });
		} else {
			sections.projects.push({ action: 'create', change: true, text: name });
		}
	}

	const secretWarnings = [];
	const schemas = new Map();
	const schemaOf = async (type) => {
		if (!schemas.has(type)) {
			const schema = await client
				.api('GET', `/credentials/schema/${encodeURIComponent(type)}`)
				.catch((error) => {
					if (error instanceof ApiError && error.status === 404) return null;
					throw error;
				});
			schemas.set(type, schema);
		}
		return schemas.get(type);
	};

	for (const project of config.projects) {
		const projectId = ids.get(project.name);
		for (const credential of project.credentials) {
			const label = `${project.name} / ${credential.name} (${credential.type})`;
			const existing = projectId
				? state.credentials.find(
						(candidate) => candidate.name === credential.name && hasOwner(candidate, projectId),
					)
				: undefined;
			if (existing) {
				if (existing.type === credential.type) {
					sections.credentials.push({ action: 'exists', text: label });
				} else {
					problems.push(`${label}: n8n has this credential with the type ${existing.type}.`);
				}
				continue;
			}

			const missing = [];
			const data = resolveData(credential.data, env, missing);
			for (const name of missing) problems.push(`${label}: set the environment variable ${name}.`);
			const schema = await schemaOf(credential.type);
			if (schema === null) {
				problems.push(`${label}: n8n has no credential type ${credential.type}.`);
			} else {
				const required = Array.isArray(schema?.required) ? schema.required : [];
				const absent = required.filter((field) => !(field in data));
				if (absent.length > 0) problems.push(`${label}: data needs ${absent.join(', ')}.`);
			}
			sections.credentials.push({ action: 'create', change: true, text: label });
			const providers = secretProviders(credential.data);
			if (providers.length > 0) {
				secretWarnings.push(
					`${label} uses the external secrets of ${providers.join(', ')}. n8n refuses the credential when the project cannot use them (Settings > External secrets).`,
				);
			}
		}
	}

	const roles = [
		...config.instanceRoles.map(({ role }) => role),
		...(config.defaultInstanceRole ? [config.defaultInstanceRole] : []),
		...config.projects.flatMap((project) => project.roles.map(({ role }) => role)),
	];
	for (const role of new Set(roles)) {
		if (!state.roleSlugs.has(role)) problems.push(`n8n has no role ${role}. Create it first.`);
	}

	const wanted = wantedRules(config, ids);
	for (const type of ['instance', 'project']) {
		const existing = state.rules.filter((rule) => rule.type === type).sort(byOrder);
		const { matches, others } = pairRules(wanted[type], existing);

		wanted[type].forEach((rule, index) => {
			sections.rules.push(
				matches[index]
					? { action: 'exists', text: `${type}  ${rule.label}` }
					: { action: 'create', change: true, text: `${type}  ${rule.label}` },
			);
		});
		for (const rule of others) {
			const label = `${type}  ${otherRuleLabel(rule, state)}`;
			sections.rules.push(
				prune
					? { action: 'delete', change: true, text: label }
					: { action: 'keep', text: `${label} (not in the config; --prune-rules deletes it)` },
			);
		}

		// apply adds the new rules at the end, then moves the rules to the order of the config:
		// the rules of the config first, then the other rules.
		const slot = (index) => matches[index]?.id ?? `new-${index}`;
		const kept = prune ? [] : others.map((rule) => rule.id);
		const afterCreate = [
			...existing.filter((rule) => !prune || !others.includes(rule)).map((rule) => rule.id),
			...wanted[type].flatMap((_, index) => (matches[index] ? [] : [slot(index)])),
		];
		const target = [...wanted[type].map((_, index) => slot(index)), ...kept];
		if (target.some((id, index) => afterCreate[index] !== id)) {
			sections.rules.push({
				action: 'order',
				change: true,
				text: `${type}  move the rules to the order of the config`,
			});
		}
	}

	return {
		sections,
		problems,
		warnings: [...secretWarnings, ...ruleWarnings(config, state, ids, prune)],
		changes: Object.values(sections)
			.flat()
			.filter((step) => step.change),
	};
}

// ── apply ─────────────────────────────────────────────────────────────────────

/** Moves the rules of a type, one at a time, until they are in the order of the config. */
async function orderRules(client, type, wanted, prune, log) {
	for (let attempt = 0; attempt <= wanted.length + 1; attempt++) {
		const existing = (await client.listAll('/role-mapping-rules', { type })).sort(byOrder);
		const { matches, others } = pairRules(wanted, existing);
		const target = [...matches.filter(Boolean), ...(prune ? [] : others)];
		const index = target.findIndex((rule, position) => existing[position]?.id !== rule.id);
		if (index === -1) return;
		await client.api('POST', `/role-mapping-rules/${target[index].id}/move`, {
			targetIndex: index,
		});
		log(`  ~ moved    ${type} rule ${target[index].id} to place ${index + 1}`);
	}
	throw new Error(`The ${type} rules did not reach the order of the config.`);
}

/**
 * Makes the changes of the plan. Call it only for a plan without problems. A credential that n8n
 * refuses does not stop the other changes: the result lists it.
 */
export async function apply(config, client, { env, prune = false, log }) {
	const failures = [];
	let state = await readState(client);

	// 1. The team projects.
	const known = new Set(state.teamProjects.map((project) => project.name));
	for (const project of config.projects) {
		if (known.has(project.name)) continue;
		await client.api('POST', '/projects', {
			name: project.name,
			...(project.description && { description: project.description }),
		});
		log(`  + created  project ${project.name}`);
	}
	state = await readState(client);
	const { ids } = matchProjects(config, state);

	// 2. The team credentials, in the projects of the config.
	for (const project of config.projects) {
		const projectId = ids.get(project.name);
		if (!projectId) throw new Error(`n8n has no single team project "${project.name}".`);
		for (const credential of project.credentials) {
			if (state.credentials.some((c) => c.name === credential.name && hasOwner(c, projectId))) {
				continue;
			}
			const missing = [];
			const data = resolveData(credential.data, env, missing);
			if (missing.length > 0) {
				throw new Error(`Set the environment variables ${missing.join(', ')}.`);
			}
			try {
				await client.api('POST', '/credentials', {
					name: credential.name,
					type: credential.type,
					data,
					projectId,
				});
				log(`  + created  credential ${project.name} / ${credential.name}`);
			} catch (error) {
				if (!(error instanceof ApiError)) throw error;
				failures.push(`${project.name} / ${credential.name}: ${error.message}`);
				log(`  ! failed   credential ${project.name} / ${credential.name}: ${error.message}`);
			}
		}
	}

	// 3. The SSO group rules: create them, delete the others with --prune-rules, then order them.
	const wanted = wantedRules(config, ids);
	for (const type of ['instance', 'project']) {
		const existing = state.rules.filter((rule) => rule.type === type).sort(byOrder);
		const { matches, others } = pairRules(wanted[type], existing);
		for (const [index, rule] of wanted[type].entries()) {
			if (matches[index]) continue;
			await client.api('POST', '/role-mapping-rules', {
				expression: rule.expression,
				role: rule.role,
				type: rule.type,
				...(type === 'project' && { projectIds: rule.projectIds }),
			});
			log(`  + created  ${type} rule ${rule.label}`);
		}
		if (prune) {
			for (const rule of others) {
				await client.api('DELETE', `/role-mapping-rules/${rule.id}`);
				log(`  - deleted  ${type} rule ${otherRuleLabel(rule, state)}`);
			}
		}
		await orderRules(client, type, wanted[type], prune, log);
	}
	return failures;
}

// ── check ─────────────────────────────────────────────────────────────────────

/** Gives the results of the checks: `{ level: 'pass' | 'warn' | 'fail' | 'info', text }`. */
export async function check(config, client, { env }) {
	const results = [];
	const add = (level, text) => results.push({ level, text });

	const settings = await client.request('GET', '/rest/settings', undefined, { auth: false });
	const method = settings?.data?.userManagement?.authenticationMethod;
	if (method === 'oidc' || method === 'saml' || method === 'ldap') {
		add('pass', `Users sign in with ${method.toUpperCase()}.`);
	} else {
		add('warn', `Users sign in with ${method ?? 'an unknown method'}. Set up SSO (README.md).`);
	}

	const policy = await client.api('GET', '/settings/security-policy');
	if (policy.personalSpacePublishing) {
		add('fail', 'Users can publish workflows from their personal spaces.');
	} else {
		add('pass', 'Personal spaces cannot publish workflows.');
	}
	if (policy.publishedPersonalWorkflowsCount > 0) {
		add(
			'warn',
			`${plural(policy.publishedPersonalWorkflowsCount, 'workflow')} published from personal spaces before the limit. Move them to team projects.`,
		);
	}
	if (policy.personalSpaceSharing) {
		add('fail', 'Users can share workflows and credentials from their personal spaces.');
	} else {
		add('pass', 'Personal spaces cannot share workflows and credentials.');
	}
	const shared = policy.sharedPersonalWorkflowsCount + policy.sharedPersonalCredentialsCount;
	if (shared > 0) {
		add(
			'warn',
			`${plural(policy.sharedPersonalWorkflowsCount, 'workflow')} and ${plural(policy.sharedPersonalCredentialsCount, 'credential')} shared from personal spaces before the limit.`,
		);
	}

	const state = await readState(client);
	const result = await plan(config, state, { env, client });
	const report = (section, what) => {
		const steps = result.sections[section].filter(
			(step) => step.action === 'exists' || step.action === 'create',
		);
		const absent = steps.filter((step) => step.action === 'create');
		if (absent.length === 0) {
			add('pass', `The ${what} of the config exist (${steps.length}).`);
		} else {
			const names = absent.map((step) => step.text.replace(/\s+/g, ' ')).join('; ');
			add('fail', `Missing ${what}: ${names}. Run apply.`);
		}
	};
	report('projects', 'team projects');
	report('credentials', 'team credentials');
	report('rules', 'SSO group rules');
	if (result.sections.rules.some((step) => step.action === 'order')) {
		add('fail', 'The SSO group rules are not in the order of the config. Run apply.');
	}
	const others = result.sections.rules.filter((step) => step.action === 'keep');
	if (others.length > 0) {
		add(
			'warn',
			`${plural(others.length, 'SSO group rule')} not in the config: ${others.map((step) => step.text.split(' (')[0].replace(/\s+/g, ' ')).join('; ')}.`,
		);
	}
	for (const problem of result.problems) add('fail', problem);
	for (const warning of result.warnings) add('warn', warning);

	try {
		const triggers = await client.listAll('/inventory/open-triggers');
		const open = triggers.filter((trigger) => !trigger.approved);
		if (open.length === 0) {
			add(
				'pass',
				`No open trigger without an approval (${plural(triggers.length, 'approved open trigger')}).`,
			);
		} else {
			const names = [...new Set(open.map((trigger) => trigger.workflowName))];
			add(
				'warn',
				`${plural(open.length, 'open trigger')} without an approval, in ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}. See Settings > Open triggers.`,
			);
		}
	} catch (error) {
		if (!(error instanceof ApiError) || error.status !== 503) throw error;
		add('info', 'The open-triggers module is off, so the open triggers are not checked.');
	}

	const users = await client.listAll('/users', { includeRole: 'true' });
	const admins = users.filter(
		(user) => user.role === 'global:owner' || user.role === 'global:admin',
	);
	add(
		'info',
		`Owners and admins (${admins.length}): ${admins.map((user) => user.email).join(', ')}.`,
	);

	return results;
}

// ── The command line ──────────────────────────────────────────────────────────

const SYMBOL = { create: '+', exists: '=', delete: '-', keep: '?', order: '~' };
const TITLE = {
	projects: 'Team projects',
	credentials: 'Team credentials',
	rules: 'SSO group rules',
};

export async function main(argv, env, { log = console.log, fetchImpl = fetch } = {}) {
	let args;
	try {
		args = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				config: { type: 'string' },
				'prune-rules': { type: 'boolean' },
				help: { type: 'boolean' },
			},
		});
	} catch (error) {
		log(`${error.message}\n\n${USAGE}`);
		return 2;
	}
	const [command] = args.positionals;
	if (args.values.help || !['plan', 'apply', 'check'].includes(command)) {
		log(USAGE);
		return args.values.help ? 0 : 2;
	}
	if (!env.N8N_URL || !env.N8N_API_KEY) {
		log('Set N8N_URL and N8N_API_KEY.');
		return 2;
	}

	const configPath =
		args.values.config ?? fileURLToPath(new URL('./platform.json', import.meta.url));
	let raw;
	try {
		raw = JSON.parse(await readFile(configPath, 'utf8'));
	} catch (error) {
		log(`Cannot read the config ${configPath}: ${error.message}`);
		return 2;
	}
	const { config, problems: configProblems } = readConfig(raw);
	if (!config) {
		log(`The config ${configPath} has problems:`);
		for (const problem of configProblems) log(`  ! ${problem}`);
		return 1;
	}

	const client = createClient(env.N8N_URL, env.N8N_API_KEY, fetchImpl);
	const prune = args.values['prune-rules'] === true;

	try {
		if (command === 'check') {
			log(`Check of ${env.N8N_URL}\n`);
			const results = await check(config, client, { env });
			for (const { level, text } of results) log(`${level.toUpperCase().padEnd(4)}  ${text}`);
			return results.some((result) => result.level === 'fail') ? 1 : 0;
		}

		const result = await plan(config, await readState(client), { env, prune, client });
		log(
			`${command === 'plan' ? 'Plan' : 'Apply'} for ${env.N8N_URL} (claim "${config.groupsClaim}")\n`,
		);
		for (const [section, steps] of Object.entries(result.sections)) {
			log(TITLE[section]);
			if (steps.length === 0) log('  (none in the config)');
			for (const step of steps)
				log(`  ${SYMBOL[step.action]} ${step.action.padEnd(7)} ${step.text}`);
			log('');
		}
		for (const problem of result.problems) log(`  ! ${problem}`);
		for (const warning of result.warnings) log(`Warning: ${warning}`);
		const summary = `${plural(result.changes.length, 'change')}, ${plural(result.problems.length, 'problem')}.`;
		if (command === 'plan' || result.problems.length > 0 || result.changes.length === 0) {
			log(
				result.problems.length > 0
					? `${summary} Fix the problems before apply.`
					: `${summary}${result.changes.length > 0 && command === 'plan' ? ' Run apply to make the changes.' : ''}`,
			);
			return result.problems.length > 0 ? 1 : 0;
		}

		log('Changes:');
		const failures = await apply(config, client, { env, prune, log });
		if (failures.length > 0) {
			log(`\n${plural(failures.length, 'credential')} failed. Fix them, then run apply again.`);
			return 1;
		}
		const after = await plan(config, await readState(client), { env, prune, client });
		if (after.changes.length > 0 || after.problems.length > 0) {
			log(
				`After apply, ${plural(after.changes.length, 'change')} and ${plural(after.problems.length, 'problem')} are left.`,
			);
			return 1;
		}
		log('\nDone. n8n matches the config.');
		return 0;
	} catch (error) {
		log(`Stopped: ${error.message}`);
		return 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = await main(process.argv.slice(2), process.env);
}
