export class LocalgateNodeOptions
{
  private static readonly bootstrapUrlConst = new URL("./localgateNodeBootstrap.mjs", import.meta.url).href;

  static apply(env: NodeJS.ProcessEnv, bootstrapUrl = LocalgateNodeOptions.bootstrapUrlConst): NodeJS.ProcessEnv
  {
    const result = { ...env };
    const importOption = `--import=${bootstrapUrl}`;
    const options = result.NODE_OPTIONS?.trim();

    if (options?.split(/\s+/).includes(importOption)) return result;
    result.NODE_OPTIONS = options ? `${options} ${importOption}` : importOption;
    return result;
  }
}
