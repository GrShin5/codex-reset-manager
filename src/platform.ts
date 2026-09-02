export const MACOS_ONLY_MESSAGE = "Codex Reset Manager is supported only on macOS; Windows support is not implemented.";

export function assertSupportedPlatform(platform = process.platform): void {
  if (platform !== "darwin") {
    throw new Error(MACOS_ONLY_MESSAGE);
  }
}
