import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { getDataDir } from './storage.mjs';

const STRING_KEYS = ['endpoint', 'browserModule', 'chromePath', 'profilePath'];
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

/** One selection policy for tasks and browser commands. Explicit connections
 * replace the persisted connection as a whole, including its profile guard. */
export async function resolveBrowserOptions({
  endpoint = process.env.CHATGPT_WEB_CDP_URL,
  browserModule = process.env.CHATGPT_WEB_BROWSER_MODULE,
  profilePath = process.env.CHATGPT_WEB_PROFILE_PATH,
} = {}) {
  const config = endpoint || browserModule ? {} : await loadBrowserConfig();
  endpoint ||= config.endpoint;
  browserModule ||= config.browserModule;
  profilePath ||= config.profilePath;
  if (profilePath && !isAbsolute(profilePath))
    throw Object.assign(new Error('profilePath must be an absolute profile directory path'), {
      code: 'CONFIG_INVALID',
    });
  const flag = process.env.CHATGPT_WEB_MANAGED;
  const managed =
    flag === '0' || flag === 'false'
      ? false
      : flag === '1' || flag === 'true'
        ? true
        : (config.managed ?? true);
  const mode = endpoint ? 'endpoint' : browserModule ? 'adapter' : managed ? 'managed' : 'disabled';
  // A pinned existing profile must never become a launch directory or silently
  // select the isolated managed browser when its connection is missing.
  if (profilePath && mode === 'managed')
    throw Object.assign(new Error('profilePath requires an existing endpoint or browserModule'), {
      code: 'CONFIG_INVALID',
    });
  return {
    mode,
    endpoint,
    browserModule,
    profilePath,
    chromePath: process.env.CHATGPT_WEB_CHROME || config.chromePath || null,
    headless: !!config.headless,
  };
}
