import { useEffect, useState, type KeyboardEvent } from 'react';
import { Alert, Button, TextInput } from '@mantine/core';
import type { ImportHotkey } from '../shared/contracts';

export const DEFAULT_IMPORT_HOTKEY: ImportHotkey = { code: 'KeyA', ctrl: true, alt: true, shift: false, win: false };
const STORAGE_KEY = 'pwtools:import-hotkey';
const specialKeys: Record<string, string> = { Backspace: 'Backspace', Tab: 'Tab', Space: 'Space', Enter: 'Enter', Escape: 'Esc', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
const supportedCode = (code: string) => code !== 'F12' && (/^Key[A-Z]$|^Digit[0-9]$|^F([1-9]|1[0-9]|2[0-4])$/.test(code) || Object.hasOwn(specialKeys, code));

export function initialImportHotkey(): ImportHotkey | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === null) return DEFAULT_IMPORT_HOTKEY;
    const value: unknown = JSON.parse(saved);
    if (value === null) return null;
    if (typeof value === 'object' && value !== null) {
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.code === 'string' && supportedCode(candidate.code) && typeof candidate.ctrl === 'boolean' && typeof candidate.alt === 'boolean' && typeof candidate.shift === 'boolean' && typeof candidate.win === 'boolean' && (candidate.ctrl || candidate.alt || candidate.win)) return { code: candidate.code, ctrl: candidate.ctrl, alt: candidate.alt, shift: candidate.shift, win: candidate.win };
    }
  } catch { /* Use the default when a saved preference is unavailable. */ }
  return DEFAULT_IMPORT_HOTKEY;
}

export function storeImportHotkey(shortcut: ImportHotkey | null) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcut));
}

export function importHotkeyText(shortcut: ImportHotkey | null): string {
  if (!shortcut) return '已禁用';
  const key = shortcut.code.startsWith('Key') ? shortcut.code.slice(3) : shortcut.code.startsWith('Digit') ? shortcut.code.slice(5) : specialKeys[shortcut.code] || shortcut.code;
  return [shortcut.ctrl && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', shortcut.win && 'Win', key].filter(Boolean).join(' + ');
}

export default function ImportShortcut({ shortcut, error, busy, onSave, onEditingChange }: { shortcut: ImportHotkey | null; error: string; busy: boolean; onSave: (shortcut: ImportHotkey | null) => Promise<boolean>; onEditingChange: (editing: boolean) => void }) {
  const [draft, setDraft] = useState<ImportHotkey>(shortcut || DEFAULT_IMPORT_HOTKEY);
  const [inputError, setInputError] = useState('');
  useEffect(() => { setDraft(shortcut || DEFAULT_IMPORT_HOTKEY); setInputError(''); }, [shortcut]);
  useEffect(() => {
    const stopEditing = () => onEditingChange(false);
    window.addEventListener('blur', stopEditing);
    return () => { window.removeEventListener('blur', stopEditing); stopEditing(); };
  }, [onEditingChange]);
  const capture = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.code === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    event.preventDefault(); event.stopPropagation();
    if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(event.code)) return;
    if (event.code === 'F12') { setInputError('F12 不能用作导入快捷键，请选择其他按键。'); return; }
    if (!supportedCode(event.code) || (!event.ctrlKey && !event.altKey && !event.metaKey)) { setInputError('请使用 Ctrl、Alt 或 Win 与另一个按键组合。'); return; }
    setDraft({ code: event.code, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, win: event.metaKey }); setInputError('');
  };
  return <section className="panel settings-section">
    <div className="section-heading"><h2>快捷导入</h2></div>
    <div className="settings-hotkey">
      <p>在其他程序中按快捷键，单击选择窗口或按住拖动框选，确认后会自动识别截图类型，战绩进入订单导入，枪支属性进入改枪码管理；无法判断时可手动选择。按 Esc 取消截图。</p>
      <TextInput label="截图快捷键" description="点击输入框后按下组合键。建议 Ctrl + Alt + A。" value={importHotkeyText(draft)} readOnly disabled={busy} onFocus={() => onEditingChange(true)} onBlur={() => onEditingChange(false)} onKeyDown={capture} error={inputError} />
      {error && <Alert color="orange" title="快捷键未生效">{error}</Alert>}
      <div className="settings-hotkey-actions"><span>当前：{importHotkeyText(shortcut)}</span><Button variant="default" disabled={busy || !shortcut} onClick={() => void onSave(null)}>清除快捷键</Button><Button loading={busy} disabled={Boolean(inputError)} onClick={() => void onSave(draft)}>保存快捷键</Button></div>
    </div>
  </section>;
}
