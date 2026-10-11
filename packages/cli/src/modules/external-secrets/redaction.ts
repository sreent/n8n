import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';

/**
 * Fork code (not in upstream n8n). The settings as the API shows them: the value of each password
 * field of the form is the blanking value, also an empty value.
 */
export function redactSettings(settings: IDataObject, properties: INodeProperties[]) {
	const redacted: IDataObject = { ...settings };
	for (const property of properties) {
		if (property.typeOptions?.password && redacted[property.name] !== undefined) {
			redacted[property.name] = CREDENTIAL_BLANKING_VALUE;
		}
	}
	return redacted;
}

/**
 * New settings from the API, in which each blanking value takes the stored value. A value without
 * a stored value stays as it is. Settings that are not an object stay as they are.
 */
export function mergeBlankedValues(settings: IDataObject, stored: IDataObject | undefined) {
	if (Array.isArray(settings) || !stored) return settings;
	const merged: IDataObject = { ...settings };
	for (const [key, value] of Object.entries(merged)) {
		if (value === CREDENTIAL_BLANKING_VALUE && key in stored) merged[key] = stored[key];
	}
	return merged;
}
