import type { SecretBox } from '../db/secrets.ts';
import { EngineError } from '../errors.ts';
import type { SettingsStore } from './settings.ts';

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Project name, secrets (`{{secrets.project.NAME}}`, encrypted) and variables (`{{env.NAME}}`). */
export class ProjectStore {
  private readonly settings: SettingsStore;
  private readonly box: SecretBox;
  private cache: Record<string, string> | undefined;

  constructor(settings: SettingsStore, box: SecretBox) {
    this.settings = settings;
    this.box = box;
  }

  info(): { name: string; id: string } {
    return this.settings.get('project.info', { name: 'My Project', id: 'local' });
  }

  setInfo(info: { name?: string }): { name: string; id: string } {
    const current = this.info();
    const name = info.name?.trim();
    if (name !== undefined && (!name || name.length > 100)) throw new EngineError('BAD_PAYLOAD', 'Project name must contain 1–100 characters');
    const next = { ...current, ...(name ? { name } : {}) };
    this.settings.set('project.info', next);
    return next;
  }

  secrets(): Record<string, string> {
    if (!this.cache) {
      const sealed = this.settings.get<string | null>('project.secrets', null);
      this.cache = sealed ? this.box.openJson<Record<string, string>>(sealed) : {};
    }
    return { ...this.cache };
  }

  secretNames(): string[] {
    return Object.keys(this.secrets()).sort();
  }

  setSecret(name: string, value: string): void {
    if (!NAME.test(name)) throw new EngineError('BAD_PAYLOAD', 'Secret names use letters, digits and _');
    const all = { ...this.secrets(), [name]: String(value) };
    this.settings.set('project.secrets', this.box.sealJson(all));
    this.cache = all;
  }

  deleteSecret(name: string): boolean {
    const all = this.secrets();
    if (!(name in all)) return false;
    delete all[name];
    this.settings.set('project.secrets', this.box.sealJson(all));
    this.cache = all;
    return true;
  }

  env(): Record<string, string> {
    return this.settings.get<Record<string, string>>('project.env', {});
  }

  setEnv(vars: Record<string, unknown>): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) {
      if (!NAME.test(k)) throw new EngineError('BAD_PAYLOAD', `Invalid variable name ${k}`);
      clean[k] = String(v ?? '');
    }
    this.settings.set('project.env', clean);
    return clean;
  }
}
