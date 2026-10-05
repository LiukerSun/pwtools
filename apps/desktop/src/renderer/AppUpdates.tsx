import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Progress } from '@mantine/core';
import { CheckCircle2, Download, RefreshCw, RotateCw, X } from 'lucide-react';
import type { AppInfo, UpdateState } from '../shared/contracts';
import { api, errorInfo } from './api';
import './updates.css';

export function useAppUpdates(appInfo: AppInfo | null) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [requestError, setRequestError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const announcedVersions = useRef(new Set<string>());
  const live = useRef(false);
  const operation = useRef(false);
  useEffect(() => {
    if (!appInfo?.updatesSupported) return;
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let active = false;
      try {
        const next = await api.getUpdateState();
        if (!live.current) return;
        setState(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        active = ['checking', 'downloading', 'installing'].includes(next.phase);
      } catch { /* Background checks never interrupt the ledger. */ }
      if (live.current) timer = setTimeout(() => void poll(), active ? 750 : 5000);
    };
    void poll();
    return () => { live.current = false; clearTimeout(timer); };
  }, [appInfo?.updatesSupported]);
  useEffect(() => {
    if (!state?.latestVersion || !['available', 'ready'].includes(state.phase) || announcedVersions.current.has(state.latestVersion)) return;
    announcedVersions.current.add(state.latestVersion);
    setPromptOpen(true);
  }, [state?.phase, state?.latestVersion]);
  const check = useCallback(async () => {
    if (operation.current) return;
    operation.current = true;
    setRequestError('');
    try { const next = await api.checkForUpdates(); if (live.current) setState(next); }
    catch (error) { if (live.current) setRequestError(errorInfo(error).message); }
    finally { operation.current = false; }
  }, []);
  const download = useCallback(async () => {
    if (operation.current) return;
    operation.current = true; setRequestError('');
    try { const next = await api.downloadUpdate(); if (live.current) setState(next); }
    catch (error) { if (live.current) setRequestError(errorInfo(error).message); }
    finally { operation.current = false; }
  }, []);
  const install = useCallback(async () => {
    if (operation.current) return false;
    operation.current = true; setInstalling(true); setRequestError('');
    try { await api.installUpdate(); return true; }
    catch (error) {
      if (live.current) { setRequestError(errorInfo(error).message); setInstalling(false); setPromptOpen(true); }
      operation.current = false;
      return false;
    }
  }, []);
  const dismissPrompt = useCallback(() => setPromptOpen(false), []);
  return { state, error: requestError || state?.error || '', installing, check, download, install, promptOpen, dismissPrompt };
}

export type AppUpdates = ReturnType<typeof useAppUpdates>;
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function DownloadProgress({ state }: { state: UpdateState }) {
  const percent = state.totalBytes ? Math.min(100, Math.floor(state.downloadedBytes / state.totalBytes * 100)) : 0;
  return <div className="update-progress"><Progress value={percent} aria-label="更新下载进度" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} /><span>{megabytes(state.downloadedBytes)} / {megabytes(state.totalBytes)} · {percent}%</span></div>;
}

export function UpdateNotice({ updates, onOpen }: { updates: AppUpdates; onOpen: () => void }) {
  const [dismissed, setDismissed] = useState('');
  const state = updates.state;
  if (!state || !['available', 'ready', 'downloading', 'download-error'].includes(state.phase) || dismissed === state.latestVersion) return null;
  const ready = state.phase === 'ready';
  const downloading = state.phase === 'downloading';
  return <div className="update-notice" role="status"><span className="update-notice-icon"><Download size={18} aria-hidden="true" /></span><div><strong>{downloading ? `正在下载新版本 v${state.latestVersion}` : ready ? `新版本 v${state.latestVersion} 已准备好` : `发现新版本 v${state.latestVersion}`}</strong><p>{ready ? '可在方便时安装，完成后自动重启。' : downloading ? '下载在后台进行，你可以继续使用。' : '可选择现在更新，也可以继续使用当前版本。'}</p></div><Button size="xs" variant="light" onClick={onOpen}>{downloading ? '查看进度' : '查看更新'}</Button><button className="update-dismiss" aria-label="稍后处理更新" title="稍后处理" onClick={() => setDismissed(state.latestVersion || '')}><X size={16} /></button></div>;
}

export function StartupUpdatePrompt({ updates, onInstall }: { updates: AppUpdates; onInstall: () => void }) {
  const state = updates.state;
  const downloading = state?.phase === 'downloading';
  const ready = state?.phase === 'ready';
  const failed = state?.phase === 'download-error';
  const busy = updates.installing || state?.phase === 'installing';
  const offered = state && ['available', 'ready', 'downloading', 'download-error', 'installing'].includes(state.phase);
  return <Modal title={ready ? '新版本已准备好' : '发现新版本'} opened={updates.promptOpen && Boolean(offered)} onClose={() => !busy && updates.dismissPrompt()} centered size="md" zIndex={350} withCloseButton={!busy} closeOnEscape={!busy} closeOnClickOutside={false}>
    <div className="update-offer-heading"><span className="update-offer-icon"><Download size={24} aria-hidden="true" /></span><div><h3>PWTools v{state?.latestVersion}</h3><p>当前版本 v{state?.currentVersion} · {megabytes(state?.totalBytes || 0)}</p></div></div>
    <p className="update-offer-copy">{busy ? '正在启动安装程序，请稍候。' : ready ? '安装会退出当前应用，完成后自动启动。你的账户和账本数据会保留。' : downloading ? '正在下载更新，你也可以切换到后台下载并继续使用。' : '选择更新后才会下载安装包，下载完成后再确认安装。暂不更新也能继续使用。'}</p>
    {state?.notes && <div className="update-offer-notes"><strong>更新内容</strong><p>{state.notes}</p></div>}
    {downloading && state && <DownloadProgress state={state} />}
    {updates.error && <Alert color="orange" role="alert" mt="md">{updates.error}</Alert>}
    <div className="update-offer-actions"><Button variant="default" data-autofocus disabled={busy} onClick={updates.dismissPrompt}>{downloading ? '后台下载' : ready ? '稍后安装' : failed ? '稍后处理' : '暂不更新'}</Button><Button leftSection={ready ? <RotateCw size={16} /> : <Download size={16} />} loading={downloading || busy} onClick={() => { if (ready) { updates.dismissPrompt(); onInstall(); } else { void updates.download(); } }}>{busy ? '正在安装' : downloading ? '正在下载' : ready ? '退出并安装' : failed ? '重试下载' : '立即更新'}</Button></div>
  </Modal>;
}

export function UpdateSettings({ updates, onInstall }: { updates: AppUpdates; onInstall: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const state = updates.state;
  const busy = updates.installing || state?.phase === 'installing';
  const checking = state?.phase === 'checking';
  const downloading = state?.phase === 'downloading';
  const ready = state?.phase === 'ready';
  const available = state?.phase === 'available' || state?.phase === 'download-error';
  const description = busy ? '正在启动安装程序…' : checking ? '正在检查新版本…' : downloading ? `正在下载 v${state.latestVersion}` : ready ? `v${state.latestVersion} 已下载，随时可安装` : available ? `发现新版本 v${state.latestVersion}` : state?.phase === 'up-to-date' ? '当前已是最新版本' : '每次启动检查新版本，由你决定是否更新。';
  return <section className="panel settings-section update-settings" aria-label="版本更新"><div className="section-heading"><h2>版本更新</h2><span className="update-version">v{state?.currentVersion || '…'}</span></div><div className="settings-row"><div><strong className="update-status">{state?.phase === 'up-to-date' && <CheckCircle2 size={17} aria-hidden="true" />}{description}</strong><p>{available ? '选择更新后才开始下载，暂不更新也可继续使用。' : '安装前会退出应用，完成后自动启动；账户和账本将保留。'}</p></div>{ready || busy ? <Button leftSection={<RotateCw size={16} />} loading={busy} onClick={() => setConfirming(true)}>安装更新</Button> : available ? <Button leftSection={<Download size={16} />} onClick={() => void updates.download()}>{state?.phase === 'download-error' ? '重试下载' : '立即更新'}</Button> : <Button variant="default" leftSection={<RefreshCw size={16} />} loading={checking} disabled={downloading} onClick={() => void updates.check()}>{updates.error ? '重试更新' : '检查更新'}</Button>}</div>
    {downloading && state && <DownloadProgress state={state} />}
    {updates.error && <Alert color="orange" role="alert">{updates.error}</Alert>}
    {(available || ready || downloading) && state?.notes && <details className="update-notes" open={available || ready}><summary>本次更新</summary><p>{state.notes}</p></details>}
    <Modal title="安装版本更新" opened={confirming} onClose={() => !busy && setConfirming(false)} centered size="sm" closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}><p className="update-confirm-copy">将退出当前应用并安装 v{state?.latestVersion}，完成后自动启动。你的账户和账本数据会保留。</p><div className="update-confirm-actions"><Button variant="default" disabled={busy} onClick={() => setConfirming(false)}>稍后更新</Button><Button loading={busy} onClick={() => { setConfirming(false); onInstall(); }}>退出并安装</Button></div></Modal>
  </section>;
}
