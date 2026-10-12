// Fork test (not in upstream n8n): a golden test of the mapping of the evaluation tables of
// `@n8n/db`, as TypeORM builds it at run time: the columns, the relations and the indices of each
// entity. The snapshot was recorded against the enterprise entities, and the fork entities give
// the same snapshot. See `packages/@n8n/db/src/entities/FORK.md`.
import { testDb } from '@n8n/backend-test-utils';
import { EvaluationCollection, EvaluationConfig, TestCaseExecution, TestRun } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

beforeAll(async () => {
	await testDb.init();
});

afterAll(async () => {
	await testDb.terminate();
});

const typeName = (type: unknown) =>
	typeof type === 'function' ? `fn:${(type as { name: string }).name}` : type;

test('the mapping of the evaluation tables', () => {
	const dataSource = Container.get(DataSource);
	const out: Record<string, unknown> = {};
	for (const entity of [TestRun, TestCaseExecution, EvaluationConfig, EvaluationCollection]) {
		const metadata = dataSource.getMetadata(entity);
		out[entity.name] = {
			tableName: metadata.tableName,
			columns: metadata.columns.map((column) => ({
				property: column.propertyPath,
				database: column.databaseName,
				type: typeName(column.type),
				length: column.length || undefined,
				nullable: column.isNullable,
				default: column.default,
				primary: column.isPrimary || undefined,
				generated: column.isGenerated ? column.generationStrategy : undefined,
				createDate: column.isCreateDate || undefined,
				updateDate: column.isUpdateDate || undefined,
				select: !column.isSelect ? false : undefined,
				transformer: column.transformer ? 'yes' : undefined,
				relation: column.relationMetadata?.propertyPath,
			})),
			relations: metadata.relations.map((relation) => ({
				property: relation.propertyPath,
				type: relation.relationType,
				target: typeName(relation.type),
				inverse: relation.inverseSidePropertyPath || undefined,
				joinColumns: relation.joinColumns.map((column) => column.databaseName),
				onDelete: relation.onDelete,
				eager: relation.isEager || undefined,
				lazy: relation.isLazy || undefined,
				nullable: relation.isNullable,
			})),
			indices: metadata.indices.map((index) => ({
				columns: index.columns.map((column) => column.databaseName),
				unique: index.isUnique || undefined,
			})),
			uniques: metadata.uniques.map((unique) =>
				unique.columns.map((column) => column.databaseName),
			),
			foreignKeys: metadata.foreignKeys.map((key) => ({
				columns: key.columnNames,
				table: key.referencedTablePath,
				onDelete: key.onDelete,
			})),
			instanceKeys: Object.keys(new (entity as new () => object)()),
		};
	}
	expect(out).toMatchSnapshot();
});
