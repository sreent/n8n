/**
 * Fork code (not in upstream n8n): the settings that the Git processes of source control, Git
 * connections (promotions) and Git sync share.
 */

/** Source control and Git connections run Git with this `PATH` only. The Docker image has Git and ssh there. */
export const GIT_PATH = '/usr/bin:/bin';

/** The largest output of a Git call that n8n reads. */
export const GIT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Variables that name a private certificate authority for Git over HTTPS. */
export const GIT_CA_VARIABLES = ['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH'] as const;

/** A credential helper that gives Git the HTTPS credentials from two variables of its environment. */
export function gitCredentialHelper(usernameVariable: string, passwordVariable: string) {
	return `!f() { echo "username=\${${usernameVariable}}"; echo "password=\${${passwordVariable}}"; }; f`;
}
