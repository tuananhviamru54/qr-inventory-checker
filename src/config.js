import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(file = 'config.json', cwd = process.cwd()) {
  const envFile = path.join(cwd, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const full = path.resolve(cwd, file);
  if (!fs.existsSync(full)) throw new Error(`Không thấy file cấu hình: ${full}`);
  const config = JSON.parse(fs.readFileSync(full, 'utf8'));
  return withDefaults(config, path.dirname(full));
}

export function withDefaults(config, root) {
  const dirs = config.dirs ?? {};
  return {
    title: 'Báo cáo đối chiếu MISA AMIS',
    period: 'thisMonth',
    ...config,
    root,
    dirs: {
      downloads: path.resolve(root, dirs.downloads ?? 'downloads'),
      output: path.resolve(root, dirs.output ?? 'output'),
      profile: path.resolve(root, dirs.profile ?? '.auth/profile'),
    },
    ai: {
      model: 'claude-opus-5-5',
      ...(config.ai ?? {}),
    },
    bot: { maxDataAgeMinutes: 30, maxReviewRounds: 2, ...(config.bot ?? {}) },
    secrets: {
      // chấp nhận cả tên biến MISA_WEB_*
      username: process.env.AMIS_USERNAME || process.env.MISA_WEB_USERNAME,
      password: process.env.AMIS_PASSWORD || process.env.MISA_WEB_PASSWORD,
      targetDb: process.env.AMIS_TARGET_DB || process.env.MISA_WEB_TARGET_DB || config.amis?.targetDb,
      totpSecret: process.env.AMIS_TOTP_SECRET,
      telegramToken: process.env.TELEGRAM_BOT_TOKEN,
      telegramChatId: process.env.TELEGRAM_CHAT_ID,
      telegramApiBase: process.env.TELEGRAM_API_BASE,
      ...(config.secrets ?? {}),
    },
  };
}
