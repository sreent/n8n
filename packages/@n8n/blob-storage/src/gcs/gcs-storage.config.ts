import { Config, Env, nonnegativeIntSchema } from '@n8n/config';

/**
 * Fork config (not in upstream n8n): the native Google Cloud Storage of the object store. With a
 * bucket name, the object store (mode `s3`) keeps its data in Google Cloud Storage through the
 * JSON API, and signs in without an HMAC key. See `../../FORK.md`.
 */
@Config
export class GcsStorageConfig {
	/** Name of the n8n bucket in Google Cloud Storage. */
	@Env('N8N_EXTERNAL_STORAGE_GCS_BUCKET_NAME')
	bucketName: string = '';

	/**
	 * The JSON key of a service account. Empty: the key file in `GOOGLE_APPLICATION_CREDENTIALS`,
	 * else the service account of the virtual machine or of the workload (the metadata server).
	 */
	@Env('N8N_EXTERNAL_STORAGE_GCS_CREDENTIALS')
	credentials: string = '';

	/** The API endpoint, for example a private endpoint or a test server. */
	@Env('N8N_EXTERNAL_STORAGE_GCS_API_ENDPOINT')
	apiEndpoint: string = 'https://storage.googleapis.com';

	/** Maximum number of attempts of a request that fails for a temporary reason. */
	@Env('N8N_EXTERNAL_STORAGE_GCS_MAX_ATTEMPTS')
	maxAttempts: number = 3;

	/** Milliseconds to wait for the startup check of the bucket. 0 disables the limit. */
	@Env('N8N_EXTERNAL_STORAGE_GCS_STARTUP_TIMEOUT_MS', nonnegativeIntSchema)
	startupTimeoutMs: number = 10_000;
}
