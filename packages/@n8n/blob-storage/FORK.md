# The fork's blob storage

Fork document (not in upstream n8n). Read it with [FORK.md](../../../FORK.md).

The S3 and Azure Blob storage of this package are enterprise code. The fork removed them in step 4
of FORK.md. [FORK-FEATURES.md](../../../FORK-FEATURES.md) lists them as "Binary and execution data
in S3 or Azure": not planned, because one server keeps its data in PostgreSQL.

## The stand-ins

Ordinary code loads the S3 and Azure classes by name. Fork stand-ins with the same names and
exports keep that code unchanged:

| Fork file | Enterprise file that it replaces | Behaviour |
| --- | --- | --- |
| `src/object-store/object-store.service.ts` | `object-store.service.ee.ts` | `init()` fails |
| `src/azure-blob/azure-blob.service.ts` | `azure-blob.service.ee.ts` | `init()` fails |
| `src/s3-byte-store.ts` | `s3-byte-store.ee.ts` | Each operation fails |
| `src/azure-byte-store.ts` | `azure-byte-store.ee.ts` | Each operation fails |
| `src/unavailable-storage.ts` | (new file) | The error and the base class of the byte stores |

Each failure is a `StorageUnavailableError` (a `UserError`): "S3 storage is not in this build of
n8n. Keep binary data and execution data in the database or on the filesystem."

## Behaviour

The sources are the ordinary callers: `initBinaryDataService()`, `initObjectStoreIfConfigured()`
and `initAzureStoreIfConfigured()` in `packages/cli/src/commands/base-command.ts`, the `audit`
command, and `register-blob-byte-stores.ts` of the agents module.

- When `N8N_DEFAULT_BINARY_DATA_MODE` or `N8N_EXECUTION_DATA_STORAGE_MODE` is `s3` or `azure`, n8n
  does not start. Without a licence, the licence checks of `base-command.ts` stop the start, as in
  upstream n8n. With a licence, the stand-in client fails, and `base-command.ts` stops the start.
- When only `N8N_EXTERNAL_STORAGE_S3_BUCKET_NAME` or `N8N_EXTERNAL_STORAGE_AZURE_CONTAINER_NAME` is
  set, the client fails and n8n starts without that storage. The `audit` command logs a warning.
- n8n never makes an S3 or Azure byte store, because the client fails first. The agents module
  thus registers no S3 or Azure store.

### Differences from upstream

- Without a licence, upstream n8n still starts the S3 or Azure client when the bucket or the
  container is set. Thus it can read the data that a licensed n8n stored there before. The fork
  cannot read that data. Move the data to the database or the filesystem before you change to the
  fork.
- The package keeps its dependencies on the S3 and Azure SDKs, so the lockfile stays as in
  upstream. No code loads them.

## Tests

`src/__tests__/unavailable-storage.test.ts` tests the stand-ins. The fork deleted the ordinary tests
of the enterprise classes (`s3-byte-store.test.ts`, `azure-byte-store.test.ts`, their `mocks.ts`,
and `object-store.service.test.ts`).

## Upstream updates

`scripts/sync-upstream.sh` deletes the enterprise files of this package and the deleted tests
again, as `scripts/removed-enterprise-paths.txt` tells. When upstream changes how ordinary code uses
the S3 or Azure classes, for example with a new method, add it to the stand-ins.
