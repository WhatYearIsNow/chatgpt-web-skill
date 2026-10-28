import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { getDataDir } from './storage.mjs';

const STRING_KEYS = ['endpoint', 'browserModule', 'chromePath', 'profilePath'];
const BOOLEAN_KEYS = ['managed', 'headless', 'dedicated', 'dedicatedMinimized'];
const NUMBER_KEYS = ['dedicatedPort'];

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
    Object.keys(value).some(
      (key) => ![...STRING_KEYS, ...BOOLEAN_KEYS, ...NUMBER_KEYS].includes(key),
    ) ||
    STRING_KEYS.some(
      (key) => value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim()),
    ) ||
    BOOLEAN_KEYS.some((key) => value[key] !== undefined && typeof value[key] !== 'boolean') ||
    NUMBER_KEYS.some(
      (key) =>
        value[key] !== undefined &&
        (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 65535),
    )
  )
    throw Object.assign(
      new Error(
        `config.json only accepts nonempty strings (${STRING_KEYS.join(', ')}), booleans (${BOOLEAN_KEYS.join(', ')}) and port integers (${NUMBER_KEYS.join(', ')})`,
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
  dedicatedPort = process.env.CHATGPT_WEB_DEDICATED_PORT,
} = {}) {
  const config = endpoint || browserModule ? {} : await loadBrowserConfig();
  endpoint ||= config.endpoint;
  browserModule ||= config.browserModule;
  profilePath ||= config.profilePath;
  dedicatedPort ||= config.dedicatedPort;
  if (dedicatedPort != null) {
    const port = Number(dedicatedPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Object.assign(new Error('dedicatedPort must be an integer from 1 to 65535'), {
        code: 'CONFIG_INVALID',
      });
    dedicatedPort = port;
  }
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
  const dedicatedFlag = process.env.CHATGPT_WEB_DEDICATED;
  const dedicated =
    dedicatedFlag === '1' || dedicatedFlag === 'true'
      ? true
      : dedicatedFlag === '0' || dedicatedFlag === 'false'
        ? false
        : !!config.dedicated;
  const mode = endpoint
    ? 'endpoint'
    : browserModule
      ? 'adapter'
      : dedicated
        ? 'dedicated'
        : managed
          ? 'managed'
          : 'disabled';
  // A pinned existing profile must never become a launch directory or silently
  // select the isolated managed browser when its connection is missing.
  if (profilePath && (mode === 'managed' || mode === 'dedicated'))
    throw Object.assign(new Error('profilePath requires an existing endpoint or browserModule'), {
      code: 'CONFIG_INVALID',
    });
  return {
    mode,
    endpoint,
    browserModule,
    profilePath,
    dedicatedPort: dedicatedPort || null,
    chromePath: process.env.CHATGPT_WEB_CHROME || config.chromePath || null,
    headless: !!config.headless,
    dedicatedMinimized: !!config.dedicatedMinimized,
  };
}
