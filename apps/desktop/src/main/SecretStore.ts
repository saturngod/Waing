import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";

type EncryptedSecrets = Record<string, string>;

export class SecretStore {
  constructor(private readonly path: string) {}

  async set(reference: string, secret: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS-backed secret encryption is unavailable");
    const values = await this.read();
    values[reference] = safeStorage.encryptString(secret).toString("base64");
    await this.write(values);
  }

  async get(reference: string): Promise<string | undefined> {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    const encrypted = (await this.read())[reference];
    return encrypted === undefined ? undefined : safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }

  async delete(reference: string): Promise<void> {
    const values = await this.read();
    if (!(reference in values)) return;
    delete values[reference]; await this.write(values);
  }

  private async read(): Promise<EncryptedSecrets> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as EncryptedSecrets; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw cause;
    }
  }

  private async write(values: EncryptedSecrets): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(values), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}
