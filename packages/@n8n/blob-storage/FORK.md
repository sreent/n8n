# The fork's blob storage

Fork document (not in upstream n8n). Read it with [FORK.md](../../../FORK.md).

The S3 and Azure Blob storage of this package are enterprise code. The fork removed them in step 4
of FORK.md, and the owner chose on 2026-10-14 to rebuild them (FORK-FEATURES.md, "Parity with the
Enterprise Edition", 2 of 6). The fork classes have the names and the exports of the enterprise
classes, so the ordinary code that loads them stays as it is:

| Fork file | Enterprise file that it replaces |
| --- | --- |
| `src/object-store/object-store.service.ts` | `object-store.service.ee.ts` |
| `src/s3-byte-store.ts` | `s3-byte-store.ee.ts` |
| `src/azure-blob/azure-blob.service.ts` | `azure-blob.service.ee.ts` |
| `src/azure-byte-store.ts` | `azure-byte-store.ee.ts` |

## Set up

n8n keeps binary data (`N8N_DEFAULT_BINARY_DATA_MODE=s3` or `azure`) and execution data
(`N8N_EXECUTION_DATA_STORAGE_MODE=s3` or `azure`) in a bucket or a container. The licence values
`feat:binaryDataS3`, `feat:binaryDataAz`, `feat:executionDataS3` and `feat:executionDataAz` turn
the modes on. The fork switch gives them (`packages/cli/src/fork-features.ts`), and
`N8N_FORK_FEATURES_ENABLED=false` turns them off. The variables are those of the public
documentation:

- [External storage](https://docs.n8n.io/hosting/scaling/external-storage/)
- [External data storage variables](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/external-data-storage)

### Google Cloud Storage

Google Cloud Storage has an S3 API. Use these settings:

- `N8N_EXTERNAL_STORAGE_S3_HOST=storage.googleapis.com`
- `N8N_EXTERNAL_STORAGE_S3_BUCKET_REGION=auto` (or the region of the bucket)
- `N8N_EXTERNAL_STORAGE_S3_ACCESS_KEY` and `N8N_EXTERNAL_STORAGE_S3_ACCESS_SECRET`: an HMAC key of
  a service account with access to the bucket.

The S3 SDK adds CRC32 checksums to its requests. When a service with the S3 API does not accept
them, set `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` and
`AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`. The SDK reads these variables, as the enterprise
classes let it do.

## Sources

The fork wrote these classes from these sources only:

- The public documentation (above).
- Ordinary code: the interface `ByteStore` in `src/types.ts`, the configs `ObjectStoreConfig` and
  `AzureBlobConfig`, `createFixedSizeChunker`, and the callers in
  `packages/cli/src/commands/base-command.ts`, `packages/cli/src/commands/audit.ts`,
  `packages/cli/src/modules/agents/register-blob-byte-stores.ts` and
  `packages/core/src/binary-data/blob.manager.ts`.
- The behaviour of the enterprise classes, as a black box: the golden tests in
  `src/__tests__/golden` send each operation to an in-memory S3 server and an in-memory Azure Blob
  server, and record the requests, the results, the errors and the logs. The snapshots were
  recorded against the enterprise classes in a checkout of the upstream commit of
  `scripts/sync-upstream.base`, through the ordinary index files of this package.

The fork did not read the enterprise files or their tests (`s3-byte-store.test.ts`,
`azure-byte-store.test.ts`, `mocks.ts`, `object-store.service.test.ts`, `azure-blob.service.ee.test.ts`).

## Behaviour

### S3

- `init()` logs the endpoint, the bucket, the region and the path style. Then it sends one
  `HeadBucket` request, with the limit `N8N_EXTERNAL_STORAGE_S3_STARTUP_TIMEOUT_MS` (0: no limit).
  A failure gives "Failed to connect to S3 at <endpoint> (bucket: <bucket>): <cause>. Check that
  ...". A second `init()` only logs.
- Without a host, the client uses the AWS endpoint of the region, and the path style does not
  apply. An empty region lets the SDK read `AWS_REGION`. Without auto-detection, the client signs
  with the access key and the secret, also when they are empty.
- A write reads a stream to its end, and sends one `PutObject` with the MD5 hash, the MIME type
  (default `application/octet-stream`) and the file name (`x-amz-meta-filename`, URI-encoded).
- A read sends `GetObject`. A missing key (`NoSuchKey`) gives `null`. A read as a stream pipes the
  body through a `PassThrough`, or through `createFixedSizeChunker` when a chunk size is set.
- `getMetadata` sends `HeadObject`. A 404 gives `null`.
- A copy downloads the object, reads its metadata and uploads it again. A rename copies, then
  deletes the old key with `DeleteObject`.
- A delete sends `DeleteObjects` in batches of 1000, one after the other. The first failed batch
  stops it. Keys that S3 reports as not deleted give "Failed to delete <n> of <m> objects: ..."
  with the first five keys.
- Each failed request gives "Request to S3 failed: <cause>". The SDK retries
  `N8N_EXTERNAL_STORAGE_S3_MAX_ATTEMPTS` times. The S3 client does not use the proxy variables.

### Azure Blob

- `init()` makes the client: a connection string comes first, then `DefaultAzureCredential` when
  `N8N_EXTERNAL_STORAGE_AZURE_AUTH_AUTO_DETECT=true`, then the account name and key. Without an
  endpoint, the URL is `https://<account>.blob.core.windows.net`. Then it lists one blob of the
  container. A missing container gives "Azure Blob container "<name>" does not exist or is not
  accessible.". A second `init()` does nothing.
- A write reads a stream to its end and uploads one block blob, with the MIME type as the content
  type (default `application/octet-stream`) and the file name as the metadata `filename`
  (URI-encoded).
- A read downloads the blob to a buffer. A read as a stream downloads it as a stream, as for S3.
  `getMetadata` reads the properties of the blob.
- A copy downloads the blob, reads its properties and uploads it again. A rename copies, then
  deletes the old blob.
- A delete deletes all blobs at the same time. A missing blob is no error.
- Each failed request gives "Request to Azure Blob storage failed: <cause>". The SDK retries 3
  times. The Azure SDK sends the requests of a client through `HTTPS_PROXY` or `HTTP_PROXY` when
  they are set as n8n makes the client, except to the hosts in `NO_PROXY` (which the SDK reads
  once).

### Differences from the enterprise classes

- The enterprise Azure store failed on a read or on `getMetadata` of a missing blob ("Request to
  Azure Blob storage failed: "), because the answer to the HEAD request has no body. The interface
  `ByteStore` asks for `null`, and the fork gives `null` when the code of the error is
  `BlobNotFound`. The golden test of Azure has the fork results for these two steps.

## Tests

- `src/__tests__/golden/s3-storage.golden.test.ts` and `azure-storage.golden.test.ts`, with their
  helpers `fake-s3-server.ts`, `fake-azure-server.ts` and `recording.ts`. The Azure test takes
  about three minutes, because the Azure SDK waits seconds between its retries.

## Upstream updates

- When upstream changes how ordinary code uses the S3 or Azure classes, for example with a new
  method, add it to the fork classes.
- When upstream changes the enterprise classes, record the snapshots again against them, as
  FORK.md tells. Keep the fork results of the steps in "Differences from the enterprise classes".
