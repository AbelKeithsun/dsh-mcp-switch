/**
 * Host half of the MCP switch bundle.
 *
 * Nothing is registered on the Host: every operation this page performs goes
 * through the existing `pluginManager` Remote (`listPlugins`,
 * `setPluginEnabled`), which already owns profile writes and the Loader reload
 * lifecycle. The Client module owns all rendering.
 */
export function apply() {}
