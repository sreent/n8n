/**
 * Fork code (not in upstream n8n): the types of the external secrets feature of the editor.
 * The FORK.md of this folder describes them.
 */

/** Secret names as a tree, for the completions of `$secrets`: `a.b` is `{ a: { b: '*********' } }`. */
export interface SecretsTree {
	[key: string]: SecretsTree | string;
}
