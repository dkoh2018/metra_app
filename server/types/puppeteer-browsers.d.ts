declare module '@puppeteer/browsers' {
  export enum Browser {
    CHROME = 'chrome',
    FIREFOX = 'firefox'
  }

  export enum ChromeReleaseChannel {
    STABLE = 'stable',
    BETA = 'beta',
    CANARY = 'canary',
    DEV = 'dev'
  }

  export function computeExecutablePath(options: {
    browser: Browser;
    buildId: string;
    cacheDir: string;
  }): string;

  export function resolveBuildId(browser: Browser, channel: ChromeReleaseChannel): Promise<string>;

  export function install(options: {
    browser: Browser;
    buildId: string;
    cacheDir: string;
    unpack?: boolean;
  }): Promise<void>;
}
