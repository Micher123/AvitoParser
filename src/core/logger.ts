// deno-lint-ignore-file no-explicit-any
import { Config } from "#config";

let level = 2; // info по умолчанию

// Ленивая инициализация уровня из конфига
async function getLevel(): Promise<number> {
  try {
    const config = await Config.get();
    switch (config.logLevel) {
      case "trace": return 4;
      case "debug": return 3;
      case "info": return 2;
      case "warn": return 1;
      case "error": return 0;
      default: return 2;
    }
  } catch {
    return 2;
  }
}

// Инициализируем уровень при первом использовании
let initialized = false;
async function ensureLevel() {
  if (!initialized) {
    level = await getLevel();
    initialized = true;
  }
}

function pfx(type: string): string {
  return `[${new Date().toISOString()}] [${type}]`;
}

export const log = {
  async trace(msg: unknown, ...args: unknown[]) {
    await ensureLevel();
    if (level >= 4) console.debug(pfx("trace"), msg, ...args);
  },
  async debug(msg: unknown, ...args: unknown[]) {
    await ensureLevel();
    if (level >= 3) console.debug(pfx("debug"), msg, ...args);
  },
  async info(msg: unknown, ...args: unknown[]) {
    await ensureLevel();
    if (level >= 2) console.info(pfx("info"), msg, ...args);
  },
  async warn(msg: unknown, ...args: unknown[]) {
    await ensureLevel();
    if (level >= 1) console.warn(pfx("warn"), msg, ...args);
  },
  async error(msg: unknown, ...args: unknown[]) {
    await ensureLevel();
    if (level >= 0) console.error(pfx("error"), msg, ...args);
  },
};