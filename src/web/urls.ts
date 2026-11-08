// Keep API, sync and home navigation inside the current workspace capability.
// Standalone pages use the origin root; embedded pages retain /embedded/<token>/.
export function workspaceUrl(path = ''): URL {
  return new URL(path, new URL('./', location.href));
}
