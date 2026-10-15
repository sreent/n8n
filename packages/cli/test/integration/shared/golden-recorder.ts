// Fork test helper (not in upstream n8n). The golden tests of the fork's own services use it to
// record what a service does: its result, its error, and each row that a call adds or removes.
// packages/cli/src/services/FORK.md describes the method.
import { ProjectRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { deepCopy } from 'n8n-workflow';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
// A generated id: a nanoid (16 characters, with a digit) or a UUID.
const GENERATED_ID =
	/\b((?=[A-Za-z]*\d)[A-Za-z0-9]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;
// The form of a generated nanoid, with or without a digit.
const NANOID = /^[A-Za-z0-9]{16}$/;

/** Columns with large or encrypted content. A dump leaves them out. */
const DROPPED_COLUMNS = new Set([
	'nodes',
	'connections',
	'settings',
	'staticData',
	'pinData',
	'meta',
	'data',
	'encryptedSettings',
	'password',
]);

/** The rows of each table, as normalized JSON lines. */
export type Dump = Record<string, string[]>;

export type DumpDiff = Record<string, { removed?: string[]; added?: string[] }>;

/** The scope entities of a role. They come from the role table, which services never change. */
function isScopeList(key: string, value: unknown) {
	return (
		key === 'scopes' &&
		Array.isArray(value) &&
		value.length > 0 &&
		typeof value[0] === 'object' &&
		value[0] !== null &&
		'slug' in value[0]
	);
}

function difference(left: string[], right: string[]) {
	const remaining = [...right];
	const result: string[] = [];
	for (const line of left) {
		const index = remaining.indexOf(line);
		if (index === -1) result.push(line);
		else remaining.splice(index, 1);
	}
	return result;
}

export class GoldenRecorder {
	/** Ids of the fixture, mapped to readable labels. */
	readonly labels = new Map<string, string>();

	/** Numeric ids of secrets provider connections, mapped to their provider keys. */
	readonly connectionLabels = new Map<number, string>();

	label = (id: string, name: string) => {
		this.labels.set(id, name);
		return id;
	};

	/**
	 * Generated ids without a digit. The pattern of generated ids needs a digit, so that it leaves
	 * words alone, and misses these ids.
	 */
	readonly generatedIds = new Set<string>();

	reset = () => {
		this.labels.clear();
		this.connectionLabels.clear();
		this.generatedIds.clear();
	};

	/** Shows the generated ids of the rows without a label as `<id>`, also the ids without a digit. */
	maskNewIds = async (tables: string[]) => {
		const manager = Container.get(ProjectRepository).manager;
		for (const table of tables) {
			const rows = await manager.query<Array<{ id: string }>>(`SELECT id FROM "${table}"`);
			for (const { id } of rows) {
				if (!this.labels.has(id) && NANOID.test(id)) this.generatedIds.add(id);
			}
		}
	};

	/** Labels for known ids, placeholders for dates and other generated ids. */
	labelString = (text: string): string => {
		const label = this.labels.get(text);
		if (label !== undefined) return `@${label}`;
		if (ISO_DATE.test(text)) return '<date>';
		let result = text;
		for (const [id, name] of this.labels) {
			if (result.includes(id)) result = result.replaceAll(id, `@${name}`);
		}
		for (const id of this.generatedIds) {
			if (result.includes(id)) result = result.replaceAll(id, '<id>');
		}
		return result.replace(GENERATED_ID, '<id>');
	};

	/** A copy with `toJSON` applied (as the API sends it), then labels for ids and placeholders for dates. */
	normalize = (value: unknown): unknown => {
		if (value === undefined) return '<undefined>';
		return this.normalizeValue(deepCopy(value as object));
	};

	/** The error class chain, the message and the HTTP status code of an error. */
	describeError = (error: unknown): string => {
		if (!(error instanceof Error)) return `non-error: ${String(error)}`;
		const chain: string[] = [];
		let prototype: unknown = Object.getPrototypeOf(error);
		while (prototype && prototype !== Error.prototype) {
			chain.push((prototype as { constructor: { name: string } }).constructor.name);
			prototype = Object.getPrototypeOf(prototype);
		}
		const status = 'httpStatusCode' in error ? ` [${String(error.httpStatusCode)}]` : '';
		return `${chain.join(' < ')}: ${this.labelString(error.message)}${status}`;
	};

	/** Every row of every table, and the names of the physical tables. */
	dumpDb = async (): Promise<Dump> => {
		const manager = Container.get(ProjectRepository).manager;
		const tables = [
			...new Set(manager.connection.entityMetadatas.map((metadata) => metadata.tablePath)),
		].sort();
		const dump: Dump = {};
		for (const table of tables) {
			if (table.endsWith('migrations')) continue;
			const rows = await manager.query<Array<Record<string, unknown>>>(`SELECT * FROM "${table}"`);
			dump[table] = rows.map((row) => this.normalizeRow(table, row)).sort();
		}
		const physical = await manager.query<Array<{ name: string }>>(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		);
		dump['<physical tables>'] = physical.map(({ name }) => this.labelString(name)).sort();
		return dump;
	};

	/** The rows that were removed from or added to each table. */
	diffDumps = (before: Dump, after: Dump): DumpDiff => {
		const changes: DumpDiff = {};
		for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
			const removed = difference(before[table] ?? [], after[table] ?? []);
			const added = difference(after[table] ?? [], before[table] ?? []);
			if (removed.length === 0 && added.length === 0) continue;
			changes[table] = {
				...(removed.length > 0 ? { removed } : {}),
				...(added.length > 0 ? { added } : {}),
			};
		}
		return changes;
	};

	/** Give the rows that a call added a label: their table and their name. */
	labelNewRows = async (
		tables = ['project', 'workflow_entity', 'credentials_entity', 'folder', 'user'],
	) => {
		const manager = Container.get(ProjectRepository).manager;
		for (const table of tables) {
			const rows = await manager.query<Array<{ id: string; name?: string; email?: string }>>(
				`SELECT * FROM "${table}"`,
			);
			for (const row of rows) {
				if (!this.labels.has(row.id))
					this.labels.set(row.id, `new ${table} ${row.name ?? row.email}`);
			}
		}
	};

	private normalizeValue(value: unknown): unknown {
		if (typeof value === 'string') return this.labelString(value);
		// As in JSON: `undefined` is `null` in an array and leaves out a key in an object.
		if (Array.isArray(value)) return value.map((entry) => this.normalizeValue(entry ?? null));
		if (value !== null && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value)
					.filter(([, entry]) => entry !== undefined)
					.map(([key, entry]) => [
						key,
						(/(At|Date)$/.test(key) && entry !== null) ||
						(key === 'timestamp' && typeof entry === 'number')
							? '<date>'
							: isScopeList(key, entry)
								? '<scope entities>'
								: this.normalizeValue(entry),
					]),
			);
		}
		return value;
	}

	private normalizeRow(table: string, row: Record<string, unknown>) {
		const result: Record<string, unknown> = {};
		for (const [column, value] of Object.entries(row)) {
			if (DROPPED_COLUMNS.has(column)) continue;
			if (/(At|Date)$/.test(column) && value !== null) {
				result[column] = '<date>';
			} else if (column === 'id' && typeof value === 'number') {
				result[column] = table.endsWith('secrets_provider_connection')
					? `@${this.connectionLabels.get(value) ?? '<new>'}`
					: '<n>';
			} else if (column === 'secretsProviderConnectionId' && typeof value === 'number') {
				result[column] = `@${this.connectionLabels.get(value) ?? '<new>'}`;
			} else {
				result[column] = typeof value === 'string' ? this.labelString(value) : value;
			}
		}
		return JSON.stringify(result);
	}
}
