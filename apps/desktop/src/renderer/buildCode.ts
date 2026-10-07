export type BuildMode = '烽火地带' | '全面战场';
export function parseBuildCode(value: string): { core: string; weapon: string; mode: BuildMode | ''; error: string } {
  const code = value.trim();
  if ([...code].length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(code)) return { core: '', weapon: '', mode: '', error: '改枪码过长或包含控制字符' };
  if (/^[A-Za-z0-9]{8,64}$/.test(code)) return { core: code, weapon: '', mode: '', error: '' };
  const match = /^(.*)-\s*(烽火地带|全面战场)\s*-\s*([A-Za-z0-9]{8,64})$/.exec(code);
  if (!match || !match[1].trim() || [...match[1].trim()].length > 100) return { core: '', weapon: '', mode: '', error: '请输入完整改枪码或8至64位字母数字核心码' };
  return { core: match[3], weapon: match[1].trim(), mode: match[2] as BuildMode, error: '' };
}
