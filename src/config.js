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

/** Đọc file KEY=VALUE (không đụng biến môi trường của tiến trình). */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^\s*[A-Z_][A-Z0-9_]*=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
  }));
}

/**
 * Phạm vi xem = công ty + chi nhánh (nếu sổ có nhiều chi nhánh). Mỗi chi nhánh có thư mục tải về riêng để số liệu đã lưu không lẫn nhau;
 * mã chi nhánh được bot chọn trong ô "Chi nhánh" của từng báo cáo AMIS.
 */
export function scopeConfig(config, tenantId, branchIndex) {
  const c = tenantConfig(config, tenantId);
  const t = tenantsOf(config).find((x) => x.id === c.tenant);
  const b = t?.branches?.[branchIndex ?? 0];
  if (!b) return c;
  const slug = `cn${branchIndex ?? 0}`;
  return { ...c, branchName: b.name, branchIndex: branchIndex ?? 0, branchCodes: b.codes, dirs: { ...c.dirs, downloads: path.join(c.dirs.downloads, slug) } };
}

export const tenantsOf = (config) => (config.tenants?.length ? config.tenants : [{ id: 'default', name: config.title, default: true }]);
export const defaultTenantId = (config) => (tenantsOf(config).find((t) => t.default) ?? tenantsOf(config)[0]).id;

/**
 * Cấu hình cho 1 công ty (tenant): tài khoản AMIS, sổ dữ liệu, hồ sơ trình duyệt, thư mục tải về và danh sách Nhóm VTHH riêng
 * → số liệu và phiên đăng nhập của các công ty không bao giờ lẫn nhau. Công ty mặc định dùng nguyên cấu hình gốc (.env).
 */
export function tenantConfig(config, id) {
  const t = tenantsOf(config).find((x) => x.id === id) ?? tenantsOf(config).find((x) => x.default);
  if (!t || t.default) return { ...config, tenant: t?.id ?? 'default', tenantName: t?.name, brand: t?.brand };
  const env = readEnvFile(path.resolve(config.root, t.envFile ?? `.env.${t.id}`));
  const r = (p, d) => path.resolve(config.root, p ?? d);
  return {
    ...config,
    tenant: t.id,
    tenantName: t.name,
    brand: t.brand,
    dirs: { ...config.dirs, profile: r(t.profile, `.auth-${t.id}/profile`), downloads: r(t.downloads, `downloads/${t.id}`) },
    secrets: {
      ...config.secrets,
      username: env.AMIS_USERNAME || env.MISA_WEB_USERNAME,
      password: env.AMIS_PASSWORD || env.MISA_WEB_PASSWORD,
      totpSecret: env.AMIS_TOTP_SECRET,
      targetDb: t.targetDb ?? env.AMIS_TARGET_DB ?? env.MISA_WEB_TARGET_DB,
    },
    sources: config.sources.map((s) => (s.groups ? { ...s, groups: { ...s.groups, file: t.groupsFile ?? `data/nhom_vthh.${t.id}.json` } } : s)),
  };
}
