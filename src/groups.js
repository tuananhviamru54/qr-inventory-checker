// Danh sách Nhóm VTHH (nhóm vật tư hàng hóa) của AMIS, lưu ở data/nhom_vthh.json để bot hiện cho người dùng chọn.
// Làm mới từ AMIS bằng lệnh /capnhatnhom.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const salesSource = (config) => config.sources.find((s) => s.id === 'doanh_so');
export const groupsFile = (config) => path.resolve(config.root, salesSource(config)?.groups?.file ?? 'data/nhom_vthh.json');

/** @returns {{code:string,name:string,level:number,parent:string|null}[]} */
export function loadGroups(config) {
  try {
    const list = JSON.parse(fs.readFileSync(groupsFile(config), 'utf8'));
    return Array.isArray(list) ? list.filter((g) => g?.code) : [];
  } catch { return []; }
}

export function saveGroups(config, list) {
  fs.mkdirSync(path.dirname(groupsFile(config)), { recursive: true });
  fs.writeFileSync(groupsFile(config), `${JSON.stringify(list, null, 2)}\n`);
}

/** Hậu tố tên file lưu báo cáo theo tập nhóm đã chọn ('' = tất cả nhóm). */
export const groupsKey = (codes) => (codes?.length ? crypto.createHash('sha1').update([...codes].sort().join('|')).digest('hex').slice(0, 8) : '');
