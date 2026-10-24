import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from './storage.mjs';

/** Private user configuration; never discovered in the source or current directory. */
export async function loadBrowserConfig() {
  let value;
  try { value = JSON.parse(await readFile(join(getDataDir(), 'config.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Object.assign(new Error('Cannot read private browser configuration; preserve and repair config.json'), { code: 'CONFIG_INVALID' });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['endpoint', 'browserModule'].includes(key)) ||
      Object.values(value).some(item => typeof item !== 'string' || !item.trim()))
    throw Object.assign(new Error('config.json only accepts nonempty endpoint and browserModule strings'), { code: 'CONFIG_INVALID' });
  return value;
}
