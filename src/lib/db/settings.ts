/**
 * src/lib/db/settings.ts
 *
 * Settings stored in Redis for admin configuration.
 */
import { getRedis, k } from "./redis";

export interface AppSettings {
  publicUrl?: string;
}

const SETTINGS_KEY = "relay:settings";

export async function getSettings(): Promise<AppSettings> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, string>>(SETTINGS_KEY);
  if (!raw || Object.keys(raw).length === 0) {
    return {};
  }
  return {
    publicUrl: raw.publicUrl || undefined,
  };
}

export async function updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const redis = getRedis();
  const updates: Record<string, string> = {};
  
  if (settings.publicUrl !== undefined) {
    updates.publicUrl = settings.publicUrl;
  }
  
  if (Object.keys(updates).length > 0) {
    await redis.hset(SETTINGS_KEY, updates);
  }
  
  return getSettings();
}
