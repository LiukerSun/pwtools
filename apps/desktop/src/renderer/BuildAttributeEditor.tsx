import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, FileButton, MultiSelect, NumberInput, Modal } from '@mantine/core';
import { Clipboard, ImagePlus, ScanLine } from 'lucide-react';
import type { BuildAttributeCandidate, BuildIdentity, BuildScreenshotImport } from '../shared/contracts';
import { api, errorInfo, ClientError } from './api';
import { attributeFields, blobToBase64, initialAttributes, mergeCandidates, type AttributeDraft } from './buildAttributes';

type Props = {
  value: AttributeDraft; identity: BuildIdentity; disabled: boolean;
  onChange: (value: AttributeDraft) => void; onPreviewChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void; onError: (error: unknown) => boolean;
  screenshotImport?: BuildScreenshotImport | null;
};
export default function BuildAttributeEditor({ value, identity, disabled, onChange, onPreviewChange, onBusyChange, onError, screenshotImport }: Props) {
  const [image, setImage] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [candidate, setCandidate] = useState<BuildAttributeCandidate | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const [clearDialog, setClearDialog] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const current = useRef(value); current.current = value;
  const key = JSON.stringify(identity);
  const oldKey = useRef(key);
  const importedIdentity = useRef(!!screenshotImport);
  useEffect(() => {
    if (!screenshotImport) return;
    const file = new File([new Uint8Array(screenshotImport.image.data)], screenshotImport.image.name, { type: screenshotImport.image.content_type });
    setImage(file); setCandidate(screenshotImport.candidate);
    setNotice(screenshotImport.candidate.status === 'completed' ? '截图已自动识别，请补填改枪码并核对属性后保存。' : '截图已带入，可重新识别或手工填写属性。');
  }, [screenshotImport]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; onBusyChange(false); };
  }, []);
  useEffect(() => {
    if (oldKey.current === key) return;
    if (importedIdentity.current && !current.current.confirmed) {
      oldKey.current = key;
      onChange({ ...current.current, confirmed: false }); return;
    }
    importedIdentity.current = false;
    oldKey.current = key; generation.current++; setImage(null); setCandidate(null); setBusy(false); onBusyChange(false); onPreviewChange(false);
    onChange({ ...initialAttributes(), changed: true, clear: true });
    setNotice('方案已改变，请重新录入并确认对应属性。');
  }, [key]);
  useEffect(() => {
    if (!image) { setUrl(''); return; }
    const next = URL.createObjectURL(image); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [image]);
  const choose = (file: File | null) => {
    if (!file) return;
    generation.current++; setBusy(false); onBusyChange(false); setError(''); setCandidate(null);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size === 0 || file.size > 12 * 1024 * 1024) {
      setError('请选择不超过 12 MiB 的 PNG、JPEG 或 WebP 图片。'); return;
    }
    setImage(file); onPreviewChange(true); onChange({ ...current.current, confirmed: false });
  };
  const clipboard = async () => {
    const request = generation.current;
    try {
      if (window.pwtools) {
        const native = await api.readClipboardImage();
        if (!alive.current || generation.current !== request) return;
        if (!native) throw new ClientError('NO_IMAGE', '剪贴板没有图片，请先复制属性截图。');
        choose(new File([new Uint8Array(native.data)], native.name, { type: native.content_type }));
      } else {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find(type => ['image/png', 'image/jpeg', 'image/webp'].includes(type));
          if (type) {
            const blob = await item.getType(type);
            if (alive.current && generation.current === request) choose(new File([blob], 'clipboard.png', { type }));
            return;
          }
        }
        throw new ClientError('NO_IMAGE', '剪贴板没有图片，请先复制属性截图。');
      }
    } catch (err) { if (alive.current && generation.current === request && !onError(err)) setError(errorInfo(err).message); }
  };
  const recognize = async (overwrite = false) => {
    if (!image || disabled || busy) return;
    const request = ++generation.current;
    setBusy(true); onBusyChange(true); setError('');
    try {
      const bitmap = await createImageBitmap(image);
      const pixels = bitmap.width * bitmap.height; bitmap.close();
      if (pixels > 40_000_000) throw new ClientError('INVALID_IMAGE', '图片超过 4000 万像素，请裁剪属性面板。');
      const data_base64 = await blobToBase64(image);
      if (!alive.current || generation.current !== request) return;
      const result = await api.recognizeBuildCodeAttributes({ name: image.name, content_type: image.type, data_base64 });
      if (!alive.current || generation.current !== request) return;
      setCandidate(result);
      if (result.status !== 'completed') {
        setError(result.status === 'no_text' ? '没有识别到文字，请裁剪清晰面板或手工填写。' : '没有识别到枪支属性面板，可继续手工填写。'); return;
      }
      onChange({ ...current.current, values: mergeCandidates(current.current.values, result.values, overwrite), changed: true, clear: false,
        source: 'ocr_confirmed', recognized_at: new Date().toISOString(), confirmed: false });
    } catch (err) { if (alive.current && generation.current === request && !onError(err)) setError(errorInfo(err).message); }
    finally { if (alive.current && generation.current === request) { setBusy(false); onBusyChange(false); } }
  };
  const mismatch = !!candidate?.weapon_name && candidate.weapon_name !== identity.weapon_name;
  return <section className="build-personal" aria-label="个人枪支属性">
    <div className="build-personal-heading"><h3>个人属性</h3><Button variant="subtle" color="red" size="xs" disabled={disabled} onClick={() => setClearDialog(true)}>清除个人属性</Button></div>
    <div className="build-attribute-import" tabIndex={0} aria-label="粘贴属性截图" onPaste={event => {
      const file = Array.from(event.clipboardData.items).find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
      if (file && !disabled) { event.preventDefault(); choose(file); }
    }}>
      <div className="build-import-actions"><FileButton accept="image/png,image/jpeg,image/webp" onChange={choose}>{props => <Button {...props} variant="light" leftSection={<ImagePlus size={16} />} disabled={disabled}>选择属性截图</Button>}</FileButton>
        <Button variant="default" leftSection={<Clipboard size={16} />} disabled={disabled} onClick={() => void clipboard()}>粘贴截图</Button>
        <Button variant="light" leftSection={<ScanLine size={16} />} disabled={!image || disabled} loading={busy} onClick={() => void recognize()}>识别属性</Button></div>
      <p>在此处按 Ctrl+V 粘贴截图，或直接手工填写属性。</p>
      {url && <img className="build-panel-preview" src={url} alt="待校对枪支属性截图" />}
      {image && <Button size="xs" variant="subtle" disabled={disabled || busy} onClick={() => setReplace(true)}>重新识别并替换全部值</Button>}
    </div>
    {notice && <Alert color="blue">{notice}</Alert>}
    {mismatch && <Alert color="orange">截图枪名「{candidate.weapon_name}」与当前「{identity.weapon_name}」不一致，请更正方案或在保存前明确确认。</Alert>}
    {candidate?.warnings.map((warning, index) => <Alert color="orange" key={index}>{warning}</Alert>)}
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <div className="build-attribute-fields">{attributeFields.map(([key, label, unit], index) => <NumberInput key={key} label={label} suffix={unit ? ` ${unit}` : undefined} min={0} max={key === 'price' ? 9_000_000_000_000 : 1_000_000} allowNegative={false}
      allowDecimal={!['price', 'capacity', 'fire_rate_rpm'].includes(key)} value={value.values[key] ?? ''} placeholder={index < 8 && candidate ? '未识别，请补录' : '可留空'} disabled={disabled}
      description={candidate?.confidences[key] !== undefined && candidate.confidences[key]! < .8 ? '低置信度，请核对' : undefined}
      onChange={next => { const number = next === '' ? null : Number(next); onChange({ ...value, values: { ...value.values, [key]: number !== null && Number.isFinite(number) ? number : null }, changed: true, clear: false, confirmed: false }); }} />)}</div>
    <MultiSelect label="开火模式" data={['全自动', '单发', '点射']} value={value.values.fire_modes ?? []} disabled={disabled} onChange={next => onChange({ ...value, values: { ...value.values, fire_modes: next as ('全自动' | '单发' | '点射')[] }, changed: true, clear: false, confirmed: false })} />
    {!value.clear && <Checkbox label={mismatch ? '我已核对枪名差异，并确认截图属性属于当前改枪码' : '我已核对，并确认这些属性与当前改枪码对应'} checked={value.confirmed} disabled={disabled}
      onChange={event => onChange({ ...value, confirmed: event.currentTarget.checked })} />}
    <Modal opened={replace} onClose={() => setReplace(false)} title="替换全部属性" centered size="sm"><p>重新识别将替换已填写和人工校对的属性。</p><div className="build-dialog-actions"><Button variant="default" onClick={() => setReplace(false)}>取消</Button><Button onClick={() => { setReplace(false); void recognize(true); }}>确认替换</Button></div></Modal>
    <Modal opened={clearDialog} onClose={() => setClearDialog(false)} title="清除个人属性" centered size="sm"><p>保存后清除个人属性，有目录快照时恢复显示目录结果。</p><div className="build-dialog-actions"><Button variant="default" onClick={() => setClearDialog(false)}>取消</Button><Button color="red" onClick={() => { generation.current++; setImage(null); setCandidate(null); setBusy(false); onBusyChange(false); onPreviewChange(false); onChange({ ...initialAttributes(), changed: true, clear: true }); setClearDialog(false); }}>确认清除</Button></div></Modal>
  </section>;
}
