// Fork code (not in upstream n8n): the letter and the colour of each version of a collection, in
// the order of the collection. See `../../FORK.md`.

/** The colours of the versions, as design-system colour variables. The order repeats. */
export const VERSION_PALETTE = [
	'--color--primary',
	'--color--secondary',
	'--color--success',
	'--color--warning',
	'--color--danger',
	'--color--text--tint-1',
];

export const versionColorVar = (index: number) =>
	`var(${VERSION_PALETTE[index % VERSION_PALETTE.length]})`;

/** A, B, C … Z, then AA, AB … */
export function versionLetter(index: number): string {
	const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	return index < letters.length
		? letters[index]
		: `${versionLetter(Math.floor(index / letters.length) - 1)}${letters[index % letters.length]}`;
}
