export interface ProviderCompatibility {
  providerId: string;
  testedRange: string;
  compatible: boolean;
  warning?: string;
}

const manifests: Record<string, { testedRange: string; accepts(version: number[]): boolean }> = {
  codex: {
    testedRange: "0.145.x–0.147.x",
    accepts: ([major, minor]) => major === 0 && minor !== undefined && minor >= 145 && minor <= 147,
  },
  claude: { testedRange: "0.3.x SDK", accepts: ([major, minor]) => major === 0 && minor === 3 },
  antigravity: { testedRange: "1.1.x", accepts: ([major, minor]) => major === 1 && minor === 1 },
  opencode: { testedRange: "1.x", accepts: ([major]) => major === 1 },
};

export function providerCompatibility(providerId: string, version: string): ProviderCompatibility {
  const manifest = manifests[providerId];
  if (manifest === undefined) return { providerId, testedRange: "untracked", compatible: true };
  const numeric = version.replace(/^[^\d]*/, "").split(".").map(Number);
  const compatible = numeric.every(Number.isFinite) && manifest.accepts(numeric);
  return { providerId, testedRange: manifest.testedRange, compatible,
    ...(compatible ? {} : { warning: `${providerId} ${version} is outside the tested ${manifest.testedRange} range` }) };
}

export const compatibilityManifest = Object.freeze(Object.fromEntries(
  Object.entries(manifests).map(([providerId, manifest]) => [providerId, manifest.testedRange]),
));
