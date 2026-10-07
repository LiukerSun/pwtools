import type { BuildAttributeValues, ManualBuildAttributes, ManualBuildAttributeInput, BuildIdentity } from '../shared/contracts';

export const attributeFields = [
  ['damage', '基础伤害', ''], ['armor_damage', '护甲伤害', ''], ['range_m', '优势射程', '米'],
  ['recoil_control', '后坐力控制', ''], ['handling', '操控速度', ''], ['stability', '据枪稳定性', ''],
  ['hip_fire', '腰际射击精度', ''], ['fire_rate_rpm', '射速', '发/分'], ['capacity', '容量', '发'],
  ['muzzle_velocity_mps', '枪口初速', '米/秒'], ['sound_distance_m', '枪声传播距离', '米'], ['price', '截图参考价', '哈夫币'],
] as const;
export type NumericAttributeKey = typeof attributeFields[number][0];
export interface AttributeDraft {
  values: BuildAttributeValues; source: 'manual' | 'ocr_confirmed'; recognized_at: string | null;
  confirmed: boolean; changed: boolean; clear: boolean;
}
export function initialAttributes(value?: ManualBuildAttributes | null): AttributeDraft {
  return { values: value?.values ?? {}, source: value?.source ?? 'manual', recognized_at: value?.recognized_at ?? null,
    confirmed: !!value, changed: false, clear: false };
}
export function hasMainAttributes(values: BuildAttributeValues): boolean {
  return attributeFields.slice(0, 8).some(([key]) => values[key] !== null && values[key] !== undefined);
}
export function validAttributes(values: BuildAttributeValues): boolean {
  return attributeFields.every(([key]) => {
    const value = values[key];
    return value === null || value === undefined || (Number.isFinite(value) && value >= 0 && value <= (key === 'price' ? 9_000_000_000_000 : 1_000_000)
      && (!['price', 'capacity', 'fire_rate_rpm'].includes(key) || Number.isInteger(value)));
  });
}
export function personalInput(draft: AttributeDraft, identity: BuildIdentity): ManualBuildAttributeInput | null | undefined {
  if (!draft.changed) return undefined;
  if (draft.clear) return null;
  return { identity, values: draft.values, source: draft.source, recognized_at: draft.recognized_at, confirmed: draft.confirmed };
}
export function mergeCandidates(previous: BuildAttributeValues, next: BuildAttributeValues, replace: boolean): BuildAttributeValues {
  if (replace) return { ...next };
  return Object.fromEntries([...Object.entries(next), ...Object.entries(previous).filter(([, value]) => value !== null && value !== undefined)]) as BuildAttributeValues;
}
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') { reject(new Error('图片读取失败')); return; }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onabort = () => reject(new Error('图片读取已取消'));
    reader.readAsDataURL(blob);
  });
}
export function bytesToBase64(bytes: Uint8Array): Promise<string> {
  return blobToBase64(new Blob([new Uint8Array(bytes)]));
}
