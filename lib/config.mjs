import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from './storage.mjs';

const STRING_KEYS = ['endpoint', 'browserModule', 'chromePath'];
const BOOLEAN_KEYS = ['managed', 'headless'];

/** Private user configuration; never discovered in the source or current directory. */
export async function loadBrowserConfig() {
  let value;
  try {
    value = JSON.parse(await readFile(join(getDataDir(), 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Object.assign(
      new Error('Cannot read private browser configuration; preserve and repair config.json'),
      { code: 'CONFIG_INVALID' },
    );
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => ![...STRING_KEYS, ...BOOLEAN_KEYS].includes(key)) ||
    STRING_KEYS.some(
      (key) => value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim()),
    ) ||
    BOOLEAN_KEYS.some((key) => value[key] !== undefined && typeof value[key] !== 'boolean')
  )
    throw Object.assign(
      new Error(
        `config.json only accepts nonempty strings (${STRING_KEYS.join(', ')}) and booleans (${BOOLEAN_KEYS.join(', ')})`,
      ),
      { code: 'CONFIG_INVALID' },
    );
  return value;
}
