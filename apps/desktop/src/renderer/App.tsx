import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Alert, Button, createTheme, InputWrapper, Loader, MantineProvider, Menu, Modal, PasswordInput, SegmentedControl, Select, Switch, Textarea, TextInput, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { Notifications, notifications } from '@mantine/notifications';
import { BookOpen, Calculator, ChevronDown, ChevronRight, Gamepad2, KeyRound, LogOut, Mail, Maximize2, Minus, Moon, PanelLeftClose, PanelLeftOpen, Settings2, Sun, X } from 'lucide-react';
import type { AppInfo, BuildScreenshotImport, ImportHotkey, MatchUploadInput, ScreenshotClassification, User } from '../shared/contracts';
import { api, errorInfo, isDesktop, isSessionError } from './api';
import BossLedger from './BossLedger';
import HafuRateCalculator from './HafuRateCalculator';
import RentalManager from './RentalManager';
import WeaponBuildCodes from './WeaponBuildCodes';
import ClubRecruitment from './ClubRecruitment';
import { emptyHafuRateInput, type HafuRateInput } from './hafuRate';
import { StartupUpdatePrompt, UpdateNotice, UpdateSettings, useAppUpdates, type AppUpdates } from './AppUpdates';
import ImportShortcut, { initialImportHotkey, storeImportHotkey } from './ImportShortcut';
import { blobToBase64 } from './buildAttributes';

type PageId = 'dashboard' | 'rentals' | 'build-codes' | 'hafu-rate' | 'settings';
type ThemeMode = 'dark' | 'light';
type Connection = 'checking' | 'connected' | 'failed';
// The legacy 'minimize' preference now means closing to the system tray.
type CloseBehavior = 'minimize' | 'exit';
const TRAY_CLOSE_CONFIRMED_KEY = 'pwtools:tray-close-confirmed';

const uiTheme = createTheme({
  primaryColor: 'indigo',
  colors: { indigo: ['#eef2ff', '#dfe7ff', '#c4d2ff', '#a8beff', '#91adff', '#7494ef', '#5674d5', '#405ec0', '#354fa4', '#2b428c'] },
  primaryShade: { light: 7, dark: 4 },
  fontFamily: '"Segoe UI Variable", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  headings: { fontWeight: '650' },
  defaultRadius: 'md',
  respectReducedMotion: true,
  fontSizes: { xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '20px' },
  components: {
    InputWrapper: InputWrapper.extend({ defaultProps: { inputWrapperOrder: ['label', 'input', 'description', 'error'] } }),
    Button: Button.extend({ defaultProps: { fw: 600 }, styles: (_theme, props) => ({ root: !props.disabled && (props.variant ?? 'filled') === 'filled' && (!props.color || props.color === 'indigo') ? { color: 'var(--primary-ink)' } : {} }) }),
    TextInput: TextInput.extend({ defaultProps: { size: 'md' } }),
    PasswordInput: PasswordInput.extend({ defaultProps: { size: 'md' } }),
    Textarea: Textarea.extend({ defaultProps: { size: 'md' } }),
    Select: Select.extend({ defaultProps: { size: 'md' } }),
    Modal: Modal.extend({ defaultProps: { closeButtonProps: { 'aria-label': '关闭弹窗' } } }),
  },
});

const pages = [
  { id: 'dashboard' as const, label: '老板账本', icon: BookOpen },
  { id: 'rentals' as const, label: '租号管理', icon: KeyRound },
  { id: 'build-codes' as const, label: '改枪码管理', icon: Gamepad2 },
  { id: 'hafu-rate' as const, label: '哈夫币汇率', icon: Calculator },
  { id: 'settings' as const, label: '设置', icon: Settings2 },
];

function initialTheme(): ThemeMode {
  try { return localStorage.getItem('pwtools:theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

function initialSidebarCollapsed(): boolean {
  try { return localStorage.getItem('pwtools:sidebar-collapsed') === 'true'; }
  catch { return false; }
}

function initialCloseBehavior(): CloseBehavior | null {
  try {
    const saved = localStorage.getItem('pwtools:close-behavior');
    return saved === 'minimize' || saved === 'exit' ? saved : null;
  } catch { return null; }
}

function initialTrayCloseConfirmed(): boolean {
  try { return localStorage.getItem(TRAY_CLOSE_CONFIRMED_KEY) === 'true'; }
  catch { return false; }
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior | null>(initialCloseBehavior);
  const [closeDialogOpened, setCloseDialogOpened] = useState(false);
  const [trayCloseConfirmed, setTrayCloseConfirmed] = useState(initialTrayCloseConfirmed);
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const updates = useAppUpdates(appInfo);
  const [loginUpdatesOpened, setLoginUpdatesOpened] = useState(false);
  const [connection, setConnection] = useState<Connection>('checking');
  const [restoreError, setRestoreError] = useState('');
  const [importHotkey, setImportHotkey] = useState<ImportHotkey | null>(initialImportHotkey);
  const [hotkeyError, setHotkeyError] = useState('');
  const [hotkeyBusy, setHotkeyBusy] = useState(false);
  const [importRequest, setImportRequest] = useState(0);
  const userRef = useRef(user);
  userRef.current = user;
  const hotkeyRegistration = useRef(0);
  const hotkeyQueue = useRef<Promise<void>>(Promise.resolve());
  const hotkeySavingRef = useRef(false);
  const hotkeyEditingRef = useRef(false);
  const hotkeyStartupStarted = useRef(false);
  const importHandledRef = useRef(0);
  const registerHotkey = useCallback((shortcut: ImportHotkey | null) => {
    const operation = hotkeyQueue.current.then(() => api.setImportHotkey(shortcut));
    hotkeyQueue.current = operation.catch(() => {});
    return operation;
  }, []);
  const reportHotkeyEditing = useCallback((editing: boolean) => { hotkeyEditingRef.current = editing; }, []);
  const reportImportHandled = useCallback((request: number) => { importHandledRef.current = Math.max(importHandledRef.current, request); }, []);
  const checkingRef = useRef(false);
  const workspaceCloseRef = useRef<(() => void) | null>(null);
  const registerWindowClose = useCallback((handler: (() => void) | null) => { workspaceCloseRef.current = handler; }, []);
  const requestWindowExit = useCallback(() => {
    if (workspaceCloseRef.current) { workspaceCloseRef.current(); return; }
    void api.windowControl('close').catch((error: unknown) => {
      notifications.show({ title: '关闭未完成', message: errorInfo(error).message, color: 'red' });
    });
  }, []);
  const applyCloseBehavior = useCallback((behavior: CloseBehavior) => {
    if (behavior === 'exit') { requestWindowExit(); return; }
    void api.windowControl('hide-to-tray').catch((error: unknown) => {
      notifications.show({ title: '托盘运行未启用', message: errorInfo(error).message, color: 'red' });
    });
  }, [requestWindowExit]);
  const updateCloseBehavior = useCallback((behavior: CloseBehavior) => {
    setCloseBehavior(behavior);
    try { localStorage.setItem('pwtools:close-behavior', behavior); }
    catch { /* The selected close behavior still applies for this session. */ }
  }, []);
  const requestWindowClose = useCallback(() => {
    if (closeBehavior === null || (closeBehavior === 'minimize' && !trayCloseConfirmed)) { setCloseDialogOpened(true); return; }
    applyCloseBehavior(closeBehavior);
  }, [applyCloseBehavior, closeBehavior, trayCloseConfirmed]);
  const chooseCloseBehavior = (behavior: CloseBehavior) => {
    setTrayCloseConfirmed(true);
    try { localStorage.setItem(TRAY_CLOSE_CONFIRMED_KEY, 'true'); }
    catch { /* Keep the confirmation for this session if storage is unavailable. */ }
    updateCloseBehavior(behavior);
    setCloseDialogOpened(false);
    applyCloseBehavior(behavior);
  };

  useEffect(() => api.onCloseRequested?.(requestWindowClose), [requestWindowClose]);
  useEffect(() => api.onExitRequested?.(requestWindowExit), [requestWindowExit]);
  useEffect(() => api.onImportRequested?.(() => {
    if (hotkeyEditingRef.current || hotkeySavingRef.current) return;
    setImportRequest(value => value + 1);
    if (!userRef.current) {
      void api.windowControl('restore').catch(() => {});
      notifications.show({ title: '请先登录', message: '登录后继续截图，自动识别订单战绩或枪支属性', color: 'blue' });
    }
  }), []);
  useEffect(() => {
    if (!isDesktop || hotkeyStartupStarted.current) return;
    hotkeyStartupStarted.current = true;
    const registration = ++hotkeyRegistration.current;
    void registerHotkey(importHotkey).catch((error: unknown) => {
      if (registration !== hotkeyRegistration.current) return;
      const message = errorInfo(error).message;
      setHotkeyError(message);
      notifications.show({ title: '快捷导入未启用', message: `${message} 请在设置中更改快捷键。`, color: 'orange', autoClose: 6000 });
    });
    // Register the saved machine preference once, including while signed out.
    // Settings changes register explicitly before updating the preference.
  }, []);
  const updateImportHotkey = useCallback(async (shortcut: ImportHotkey | null): Promise<boolean> => {
    if (hotkeySavingRef.current) return false;
    hotkeySavingRef.current = true;
    const registration = ++hotkeyRegistration.current;
    setHotkeyBusy(true); setHotkeyError('');
    try {
      await registerHotkey(shortcut);
      if (registration !== hotkeyRegistration.current) return false;
      setImportHotkey(shortcut);
      try { storeImportHotkey(shortcut); }
      catch { notifications.show({ title: '快捷键仅本次生效', message: '无法保存本机偏好，下次启动需重新设置。', color: 'orange' }); }
      notifications.show({ message: shortcut ? '导入快捷键已保存' : '导入快捷键已禁用', color: 'teal' });
      return true;
    } catch (error: unknown) {
      if (registration === hotkeyRegistration.current) setHotkeyError(errorInfo(error).message);
      return false;
    } finally { hotkeySavingRef.current = false; if (registration === hotkeyRegistration.current) setHotkeyBusy(false); }
  }, [registerHotkey]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    void api.setWindowTheme?.(theme).catch(() => {});
    try { localStorage.setItem('pwtools:theme', theme); } catch { /* The selected theme still applies for this session. */ }
  }, [theme]);

  const checkConnection = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setConnection('checking');
    try { await api.health(); setConnection('connected'); }
    catch { setConnection('failed'); }
    finally { checkingRef.current = false; }
  }, []);

  useEffect(() => {
    let alive = true;
    void checkConnection();
    void api.appInfo().then((info) => { if (alive) setAppInfo(info); }).catch(() => {});
    void api.me().then((currentUser) => { if (alive) setUser(currentUser); }).catch((error: unknown) => {
      if (alive && !isSessionError(error)) setRestoreError(errorInfo(error).message);
    }).finally(() => { if (alive) setRestoring(false); });
    return () => { alive = false; };
  }, [checkConnection]);

  const handleError = useCallback((error: unknown) => {
    if (!isSessionError(error)) return false;
    setUser(null);
    notifications.show({ message: '登录已过期，请重新登录', color: 'orange' });
    return true;
  }, []);

  const authenticated = (currentUser: User) => {
    setLoginUpdatesOpened(false);
    setUser(currentUser);
    setRestoreError('');
    void checkConnection();
  };

  return <MantineProvider theme={uiTheme} forceColorScheme={theme}>
    <Notifications position="top-right" autoClose={2400} limit={2} containerWidth={360} />
    <div className={`app-root${isDesktop ? '' : ' browser-app'}`}>
      <TitleBar onClose={requestWindowClose} onExit={requestWindowExit} />
      {restoring ? <div className="restore-screen"><BrandMark /><Loader size="sm" /></div> : user ? <Workspace key={user.id} user={user} onSignedOut={() => setUser(null)} onError={handleError} theme={theme} onThemeChange={setTheme} appInfo={appInfo} updates={updates} onCloseHandlerChange={registerWindowClose} closeBehavior={closeBehavior ?? 'minimize'} onCloseBehaviorChange={updateCloseBehavior} importRequest={importRequest > importHandledRef.current ? importRequest : 0} onImportHandled={reportImportHandled} importHotkey={importHotkey} hotkeyError={hotkeyError} hotkeyBusy={hotkeyBusy} onImportHotkeyChange={updateImportHotkey} onHotkeyEditingChange={reportHotkeyEditing} /> : <AuthScreen updates={updates} onOpenUpdates={() => setLoginUpdatesOpened(true)} onAuthenticated={authenticated} connection={connection} restoreError={restoreError} />}
    </div>
    {isDesktop && <Modal classNames={{ content: 'window-close-modal' }} opened={closeDialogOpened} onClose={() => setCloseDialogOpened(false)} title="关闭窗口" centered size="sm" zIndex={450}>
      <p>关闭窗口后，是否继续在系统托盘运行？托盘运行会隐藏窗口和任务栏图标，点击托盘图标可恢复窗口。我们会记住你的选择，可在设置中更改。</p>
      <div className="window-close-actions"><Button variant="default" onClick={() => setCloseDialogOpened(false)}>取消</Button><Button variant="default" onClick={() => chooseCloseBehavior('exit')}>退出应用</Button><Button onClick={() => chooseCloseBehavior('minimize')}>托盘运行</Button></div>
    </Modal>}
    <Modal className="login-update-modal" title="软件更新" opened={!user && loginUpdatesOpened} onClose={() => !updates.installing && setLoginUpdatesOpened(false)} centered withCloseButton={!updates.installing} closeOnEscape={!updates.installing} closeOnClickOutside={!updates.installing}><UpdateSettings updates={updates} onInstall={() => void updates.install()} /></Modal>
  </MantineProvider>;
}

function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><Gamepad2 size={small ? 22 : 28} strokeWidth={1.8} /></span>;
}

function TitleBar({ onClose, onExit }: { onClose: () => void; onExit: () => void }) {
  return <div className="titlebar">
    {isDesktop ? <Menu position="bottom-start" shadow="md" width={164} offset={7}>
      <Menu.Target><button className="titlebar-brand titlebar-menu-button" aria-label="应用菜单"><Gamepad2 size={16} /><span>北极星电竞-kook8866</span><ChevronDown className="titlebar-menu-chevron" size={12} /></button></Menu.Target>
      <Menu.Dropdown><Menu.Item component="a" href="https://kook.vip/Uf1rPU" target="_blank" rel="noopener noreferrer" leftSection={<Gamepad2 size={15} />}>加入 KOOK 社区</Menu.Item><Menu.Item color="red" leftSection={<LogOut size={15} />} onClick={onExit}>退出应用</Menu.Item></Menu.Dropdown>
    </Menu> : <a className="titlebar-brand" href="https://kook.vip/Uf1rPU" target="_blank" rel="noopener noreferrer" title="打开 KOOK 社区"><Gamepad2 size={16} /><span>北极星电竞-kook8866</span></a>}
    {isDesktop ? <div className="window-controls">
      <button aria-label="最小化窗口" onClick={() => void api.windowControl('minimize')}><Minus size={15} /></button>
      <button aria-label="最大化或还原窗口" onClick={() => void api.windowControl('maximize')}><Maximize2 size={13} /></button>
      <button className="window-close" aria-label="关闭窗口" onClick={onClose}><X size={16} /></button>
    </div> : <span className="preview-label">浏览器预览</span>}
  </div>;
}

interface AuthProps { onAuthenticated: (user: User) => void; connection: Connection; restoreError: string; updates: AppUpdates; onOpenUpdates: () => void }

function AuthScreen({ onAuthenticated, connection, restoreError, updates, onOpenUpdates }: AuthProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const submittingRef = useRef(false);
  const form = useForm({
    initialValues: { email: '', password: '', confirm_password: '' },
    validate: {
      email: (value) => /^\S+@\S+\.\S+$/.test(value.trim()) ? null : '请输入有效的邮箱地址。',
      password: (value) => value.length >= 10 && value.length <= 128 ? null : '密码需要 10–128 个字符。',
      confirm_password: (value, values) => mode === 'register' && value !== values.password ? '两次输入的密码不一致。' : null,
    },
  });
  const changeMode = (value: string) => {
    setMode(value as 'login' | 'register');
    setError('');
    form.clearErrors();
    form.setFieldValue('password', '');
    form.setFieldValue('confirm_password', '');
  };
  const submit = form.onSubmit(async (values) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true); setError('');
    try {
      const input = { email: values.email.trim().toLowerCase(), password: values.password };
      const currentUser = mode === 'register' ? await api.register(input) : await api.login(input);
      onAuthenticated(currentUser);
    } catch (failure) { setError(errorInfo(failure).message); }
    finally { submittingRef.current = false; setLoading(false); }
  });
  return <main className="auth-layout">
    <section className="auth-form-section" aria-label="私人账本登录">
      <div className="auth-brand"><BrandMark /><div><strong>PWTools</strong><span>你的陪玩工作台</span></div></div>
      <div className="auth-form-content" key={mode}>
        <div className="auth-form-heading"><h1>{mode === 'login' ? '登录' : '注册'}</h1><p>{mode === 'login' ? '继续管理你的老板与订单。' : '建立自己的陪玩账本。'}</p></div>
        {(error || restoreError) && <Alert color="red" className="inline-alert">{error || restoreError}</Alert>}
        <form onSubmit={submit} className="auth-form">
          <TextInput label="邮箱" type="email" placeholder="you@example.com" autoComplete="email" maxLength={254} disabled={loading} required {...form.getInputProps('email')} />
          <PasswordInput label="密码" placeholder={mode === 'login' ? '输入密码' : '10–128 个字符'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} maxLength={128} disabled={loading} required {...form.getInputProps('password')} />
          {mode === 'register' && <PasswordInput label="确认密码" placeholder="再次输入密码" autoComplete="new-password" maxLength={128} disabled={loading} required {...form.getInputProps('confirm_password')} />}
          <Button type="submit" size="md" fullWidth loading={loading}>{mode === 'login' ? '登录' : '注册'}</Button>
        </form>
      </div>
      <div className="auth-mode-switch"><Button type="button" variant="subtle" size="sm" disabled={loading} onClick={() => changeMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? '注册账号' : '返回登录'}</Button></div>
      {connection === 'failed' && <div className="auth-connection"><span className="status-dot error" />连接失败，请稍后重试</div>}
      <div className="auth-update-slot"><UpdateNotice updates={updates} onOpen={onOpenUpdates} /></div>
    </section>
    <StartupUpdatePrompt updates={updates} onInstall={() => void updates.install()} />
  </main>;
}

interface WorkspaceProps {
  user: User; onSignedOut: () => void;
  onError: (error: unknown) => boolean; theme: ThemeMode; onThemeChange: (theme: ThemeMode) => void;
  appInfo: AppInfo | null;
  updates: AppUpdates;
  onCloseHandlerChange: (handler: (() => void) | null) => void;
  closeBehavior: CloseBehavior;
  onCloseBehaviorChange: (behavior: CloseBehavior) => void;
  importRequest: number;
  onImportHandled: (request: number) => void;
  importHotkey: ImportHotkey | null;
  hotkeyError: string;
  hotkeyBusy: boolean;
  onImportHotkeyChange: (shortcut: ImportHotkey | null) => Promise<boolean>;
  onHotkeyEditingChange: (editing: boolean) => void;
}

function Workspace({ user, onSignedOut, onError, theme, onThemeChange, appInfo, updates, onCloseHandlerChange, closeBehavior, onCloseBehaviorChange, importRequest, onImportHandled, importHotkey, hotkeyError, hotkeyBusy, onImportHotkeyChange, onHotkeyEditingChange }: WorkspaceProps) {
  const [page, setPage] = useState<PageId>('dashboard');
  const [hafuRateInput, setHafuRateInput] = useState<HafuRateInput>(emptyHafuRateInput);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [ledgerVisit, setLedgerVisit] = useState(0);
  const [ledgerImportRequest, setLedgerImportRequest] = useState(0);
  const [ledgerImportImage, setLedgerImportImage] = useState<MatchUploadInput | null>(null);
  const [buildScreenshot, setBuildScreenshot] = useState<BuildScreenshotImport | null>(null);
  const [unclassified, setUnclassified] = useState<{ image: MatchUploadInput; result: ScreenshotClassification | null } | null>(null);
  const screenshotSequence = useRef(0);
  const handleBuildScreenshot = useCallback(() => setBuildScreenshot(null), []);
  const [capturing, setCapturing] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const captureBusyRef = useRef(false);
  const mountedRef = useRef(true);
  const importFlowRef = useRef(false);
  const seenImportRequest = useRef(0);
  const reportImportFlow = useCallback((opened: boolean) => {
    importFlowRef.current = opened;
    if (opened) { setLedgerImportRequest(0); setLedgerImportImage(null); }
  }, []);
  const ledgerNavigationRef = useRef({ dirty: false, busy: false });
  const pageRef = useRef(page);
  pageRef.current = page;
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [pendingClose, setPendingClose] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState(false);
  const pendingCaptureRef = useRef(false);
  const allowCloseRef = useRef(false);
  const installingUpdateRef = useRef(false);
  const reportLedgerNavigation = useCallback((state: { dirty: boolean; busy: boolean }) => { ledgerNavigationRef.current = state; }, []);
  const [signingOut, setSigningOut] = useState(false);
  const signingOutRef = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const restoreForImport = useCallback(() => {
    if (isDesktop) void api.windowControl('restore').catch((error: unknown) => {
      notifications.show({ title: '窗口未恢复', message: errorInfo(error).message, color: 'red' });
    });
  }, []);
  const requestImport = useCallback(() => {
    // An active selection owns the screen; another hotkey must not restore
    // the main window over it or start a second capture.
    if (captureBusyRef.current || installingUpdateRef.current || unclassified) return;
    const navigation = (pageRef.current === 'dashboard' || pageRef.current === 'rentals' || pageRef.current === 'build-codes') ? ledgerNavigationRef.current : { dirty: false, busy: false };
    if (navigation.busy || signingOutRef.current) { restoreForImport(); notifications.show({ message: '请等待保存或识别完成', color: 'orange' }); return; }
    if (importFlowRef.current) { restoreForImport(); notifications.show({ message: '请继续完成当前战绩导入', color: 'blue' }); return; }
    const capture = async () => {
      if (captureBusyRef.current) return;
      captureBusyRef.current = true;
      setCapturing(true);
      try {
        const image = isDesktop ? await api.captureScreen() : null;
        if (!mountedRef.current || (isDesktop && !image)) return;
        if (image) {
          restoreForImport();
          setClassifying(true);
          let result: ScreenshotClassification;
          try { result = await api.classifyScreenshot({ name: image.name, content_type: image.content_type, data_base64: await blobToBase64(new Blob([new Uint8Array(image.data)], { type: image.content_type })) }); }
          catch (error: unknown) {
            if (!mountedRef.current || onError(error)) return;
            notifications.show({ title: '自动分类未完成', message: '可手动选择截图用途，继续导入。', color: 'orange' });
            setUnclassified({ image, result: null }); return;
          }
          if (!mountedRef.current) return;
          if (result.kind === 'unknown') { setUnclassified({ image, result }); return; }
          if (result.kind === 'build_attributes') {
            setBuildScreenshot({ id: ++screenshotSequence.current, image, candidate: result.attributes });
            setPage('build-codes'); return;
          }
        }
        // Keep the current draft until a selection succeeds, including when
        // the user cancels after accepting the draft guard.
        importFlowRef.current = true;
        setLedgerImportImage(image);
        setLedgerVisit(value => value + 1);
        setLedgerImportRequest(value => value + 1);
        setPage('dashboard');
      } catch (error: unknown) {
        if (!mountedRef.current) return;
        restoreForImport();
        notifications.show({ title: '截图未完成', message: errorInfo(error).message, color: 'red' });
      } finally {
        captureBusyRef.current = false;
        if (mountedRef.current) { setCapturing(false); setClassifying(false); }
      }
    };
    if (navigation.dirty) { restoreForImport(); pendingCaptureRef.current = true; setPendingClose(false); setPendingUpdate(false); setPendingNavigation(() => () => void capture()); return; }
    void capture();
  }, [restoreForImport, onError, unclassified]);
  useEffect(() => {
    if (!importRequest || seenImportRequest.current === importRequest) return;
    seenImportRequest.current = importRequest;
    onImportHandled(importRequest);
    requestImport();
  }, [importRequest, onImportHandled, requestImport]);
  const completeWindowClose = useCallback(() => {
    allowCloseRef.current = true;
    void api.windowControl('close').catch((error: unknown) => {
      allowCloseRef.current = false;
      notifications.show({ title: '关闭未完成', message: errorInfo(error).message, color: 'red' });
    });
  }, []);
  const requestWindowClose = useCallback(() => {
    if (installingUpdateRef.current) return;
    const state = (pageRef.current === 'dashboard' || pageRef.current === 'rentals' || pageRef.current === 'build-codes') ? ledgerNavigationRef.current : { dirty: false, busy: false };
    if (state.busy || captureBusyRef.current || signingOutRef.current) {
      notifications.show({ title: '当前操作尚未完成', message: '请等待保存结果', color: 'orange' });
      return;
    }
    if (state.dirty) {
      pendingCaptureRef.current = false;
      setPendingClose(true);
      setPendingNavigation(() => completeWindowClose);
      return;
    }
    completeWindowClose();
  }, [completeWindowClose]);
  useEffect(() => {
    onCloseHandlerChange(requestWindowClose);
    return () => onCloseHandlerChange(null);
  }, [onCloseHandlerChange, requestWindowClose]);
  useEffect(() => {
    try { localStorage.setItem('pwtools:sidebar-collapsed', String(sidebarCollapsed)); }
    catch { /* The chosen layout still works if local storage is unavailable. */ }
  }, [sidebarCollapsed]);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [page, ledgerVisit]);
  useEffect(() => {
    if (!isDesktop) return;
    const protectWindow = (event: BeforeUnloadEvent) => {
      if (allowCloseRef.current) return;
      const state = (pageRef.current === 'dashboard' || pageRef.current === 'rentals' || pageRef.current === 'build-codes') ? ledgerNavigationRef.current : { dirty: false, busy: false };
      if (!state.dirty && !state.busy && !captureBusyRef.current && !signingOutRef.current) return;
      event.preventDefault();
      event.returnValue = 'pending';
      requestWindowClose();
    };
    window.addEventListener('beforeunload', protectWindow);
    return () => window.removeEventListener('beforeunload', protectWindow);
  }, [requestWindowClose]);
  const currentPage = pages.find(item => item.id === page)!;
  const runNavigation = (action: () => void, forUpdate = false) => {
    if (installingUpdateRef.current) return;
    const currentNavigation = (page === 'dashboard' || page === 'rentals' || page === 'build-codes') ? ledgerNavigationRef.current : { dirty: false, busy: false };
    if (currentNavigation.busy || captureBusyRef.current) {
      notifications.show({ message: '请等待保存或识别完成', color: 'orange' });
      return;
    }
    if (currentNavigation.dirty) { pendingCaptureRef.current = false; setPendingClose(false); setPendingUpdate(forUpdate); setPendingNavigation(() => action); return; }
    action();
  };
  const navigatePage = (nextPage: PageId) => runNavigation(() => {
    if (nextPage === 'dashboard') setLedgerVisit(value => value + 1);
    setPage(nextPage);
  });
  const installUpdate = () => runNavigation(() => {
    if (signingOutRef.current) return;
    installingUpdateRef.current = true;
    allowCloseRef.current = true;
    void updates.install().then(started => {
      if (!started) { installingUpdateRef.current = false; allowCloseRef.current = false; }
    });
  }, true);
  const logout = async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true; setSigningOut(true);
    try { await api.logout(); onSignedOut(); }
    catch (error) { if (!onError(error)) notifications.show({ title: '退出未完成', message: errorInfo(error).message, color: 'red' }); }
    finally { signingOutRef.current = false; setSigningOut(false); }
  };
  return <div className="workspace">
    <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand-row"><div className="sidebar-brand"><BrandMark small /><div><strong>PWTools</strong><span>陪玩工作台</span></div></div><Tooltip label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} position="right"><button className="sidebar-toggle" aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!sidebarCollapsed} aria-controls="pw-sidebar-navigation" onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button></Tooltip></div>
      <nav className="main-nav" id="pw-sidebar-navigation" aria-label="主导航" style={{ '--nav-index': pages.findIndex(item => item.id === page) } as CSSProperties}>
        {page !== 'settings' && <span className="nav-active-rail" aria-hidden="true" />}
        {pages.map(({ id, label, icon: Icon }) => <Tooltip key={id} label={label} position="right" disabled={!sidebarCollapsed}><button className={`nav-item ${id === 'settings' ? 'nav-item-settings' : ''} ${page === id ? 'active' : ''}`} onClick={() => navigatePage(id)} aria-label={label} aria-current={page === id ? 'page' : undefined}><Icon size={20} aria-hidden="true" /><span className="nav-text">{label}</span></button></Tooltip>)}
      </nav>
    </aside>
    <div className="workspace-body">
      <header className="workspace-header">
        <div className="header-location"><span>我的工作台</span><ChevronRight size={14} aria-hidden="true" /><strong>{currentPage.label}</strong></div>
        <div className="header-actions"><Tooltip label={theme === 'dark' ? '切换至浅色' : '切换至深色'}><button className="header-theme-toggle" aria-label={theme === 'dark' ? '切换至浅色' : '切换至深色'} onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></Tooltip><Menu position="bottom-end" shadow="md" transitionProps={{ transition: 'pop-top-right', duration: 160 }}><Menu.Target><button className="account-menu" aria-label="账号菜单"><Mail size={15} /><span title={user.email}>{user.email}</span><ChevronDown size={13} /></button></Menu.Target><Menu.Dropdown className="account-dropdown"><Menu.Label>{user.email}</Menu.Label><Menu.Item color="red" leftSection={<LogOut size={15} />} onClick={() => runNavigation(() => void logout())} disabled={signingOut}>退出登录</Menu.Item></Menu.Dropdown></Menu></div>
      </header>
      <main className="page-main" ref={mainRef} aria-label={currentPage.label}>
        <UpdateNotice updates={updates} onOpen={() => navigatePage('settings')} /><div className="page-transition" key={page}>
          {page === 'dashboard' && <BossLedger key={ledgerVisit} onError={onError} onNavigationStateChange={reportLedgerNavigation} importRequest={ledgerImportRequest} initialImportImage={ledgerImportImage} importBusy={capturing} onImportFlowChange={reportImportFlow} />}
          {page === 'rentals' && <RentalManager onError={onError} onNavigationStateChange={reportLedgerNavigation} />}
          {page === 'build-codes' && <WeaponBuildCodes onError={onError} onNavigationStateChange={reportLedgerNavigation} screenshotImport={buildScreenshot} onScreenshotHandled={handleBuildScreenshot} />}
          {page === 'hafu-rate' && <HafuRateCalculator input={hafuRateInput} onChange={setHafuRateInput} />}
          {page === 'settings' && <Settings updates={updates} onInstallUpdate={installUpdate} theme={theme} onThemeChange={onThemeChange} appInfo={appInfo} onLogout={() => runNavigation(() => void logout())} signingOut={signingOut} email={user.email} closeBehavior={closeBehavior} onCloseBehaviorChange={onCloseBehaviorChange} importHotkey={importHotkey} hotkeyError={hotkeyError} hotkeyBusy={hotkeyBusy} onImportHotkeyChange={onImportHotkeyChange} onHotkeyEditingChange={onHotkeyEditingChange} />}
        </div>
      </main>
    </div>
    <Modal opened={classifying} onClose={() => {}} title="正在识别截图类型" centered size="sm" withCloseButton={false} closeOnEscape={false} closeOnClickOutside={false}><Loader size="sm" /><p>正在区分订单战绩与改枪码属性…</p></Modal>
    <Modal opened={unclassified !== null} onClose={() => setUnclassified(null)} title="选择截图用途" centered size="sm">
      <p>没有明确识别到截图类型，请选择要导入的模块。</p>
      <div className="build-dialog-actions"><Button variant="default" onClick={() => setUnclassified(null)}>取消</Button><Button variant="light" onClick={() => {
        if (!unclassified) return;
        importFlowRef.current = true; setLedgerImportImage(unclassified.image); setLedgerVisit(value => value + 1); setLedgerImportRequest(value => value + 1); setPage('dashboard'); setUnclassified(null);
      }}>订单战绩</Button><Button onClick={() => {
        if (!unclassified) return;
        setBuildScreenshot({ id: ++screenshotSequence.current, image: unclassified.image, candidate: unclassified.result?.attributes ?? { status: 'no_fields', weapon_name: null, values: {}, confidences: {}, warnings: [], missing: [] } });
        setPage('build-codes'); setUnclassified(null);
      }}>改枪码属性</Button></div>
    </Modal>
    <Modal classNames={{ content: 'navigation-guard-modal' }} opened={pendingNavigation !== null} onClose={() => { pendingCaptureRef.current = false; setPendingNavigation(null); }} title="尚有未保存修改" centered size="sm" zIndex={400}>
      <p>离开将丢弃未保存内容。</p>
      <div className="navigation-guard-actions"><Button variant="default" onClick={() => { pendingCaptureRef.current = false; setPendingNavigation(null); }}>继续填写</Button><Button onClick={() => {
        if (ledgerNavigationRef.current.busy || captureBusyRef.current || signingOutRef.current) {
          notifications.show({ message: '请等待保存结果', color: 'orange' });
          return;
        }
        const action = pendingNavigation;
        setPendingNavigation(null);
        // A capture may resolve as canceled before React renders its busy
        // state. Preserve the draft guard until a successful capture remounts
        // the ledger rather than clearing it just for opening the selector.
        if (!pendingCaptureRef.current) reportLedgerNavigation({ dirty: false, busy: false });
        pendingCaptureRef.current = false;
        action?.();
      }}>放弃修改并{pendingClose ? '关闭' : pendingUpdate ? '更新' : '切换'}</Button></div>
    </Modal>
    <StartupUpdatePrompt updates={updates} onInstall={installUpdate} />
  </div>;
}

function Settings({ updates, onInstallUpdate, theme, onThemeChange, appInfo, onLogout, signingOut, email, closeBehavior, onCloseBehaviorChange, importHotkey, hotkeyError, hotkeyBusy, onImportHotkeyChange, onHotkeyEditingChange }: { updates: AppUpdates; onInstallUpdate: () => void; theme: ThemeMode; onThemeChange: (theme: ThemeMode) => void; appInfo: AppInfo | null; onLogout: () => void; signingOut: boolean; email: string; closeBehavior: CloseBehavior; onCloseBehaviorChange: (behavior: CloseBehavior) => void; importHotkey: ImportHotkey | null; hotkeyError: string; hotkeyBusy: boolean; onImportHotkeyChange: (shortcut: ImportHotkey | null) => Promise<boolean>; onHotkeyEditingChange: (editing: boolean) => void }) {
  return <div className="settings-layout">
    <ClubRecruitment />
    <section className="panel settings-section"><div className="section-heading"><h2>外观</h2></div><div className="settings-row"><strong>主题</strong><SegmentedControl value={theme} onChange={(value) => onThemeChange(value as ThemeMode)} data={[{ value: 'dark', label: <span className="theme-label"><Moon size={14} /> 深色</span> }, { value: 'light', label: <span className="theme-label"><Sun size={14} /> 浅色</span> }]} /></div></section>
    {isDesktop && <section className="panel settings-section"><div className="section-heading"><h2>窗口</h2></div><div className="settings-row"><Switch classNames={{ root: 'settings-close-switch', body: 'settings-close-switch-body', labelWrapper: 'settings-close-switch-label', label: 'settings-close-switch-title', description: 'settings-close-switch-description' }} label="关闭窗口时最小化到系统托盘" description="启用后，关闭窗口会隐藏任务栏图标，应用在系统托盘继续运行，点击托盘图标恢复窗口。首次关闭会询问是否托盘运行；关闭此选项后，点击关闭窗口会退出应用。" labelPosition="left" checked={closeBehavior === 'minimize'} onChange={(event) => onCloseBehaviorChange(event.currentTarget.checked ? 'minimize' : 'exit')} /></div></section>}
    {isDesktop && <ImportShortcut shortcut={importHotkey} error={hotkeyError} busy={hotkeyBusy} onSave={onImportHotkeyChange} onEditingChange={onHotkeyEditingChange} />}
    <section className="panel settings-section"><div className="section-heading"><h2>账号</h2></div><div className="settings-row"><div><strong className="settings-email">{email}</strong>{!appInfo?.persistentSession && <p>关闭后需重新登录</p>}</div><Button variant="default" color="red" leftSection={<LogOut size={15} />} loading={signingOut} onClick={onLogout}>退出登录</Button></div></section>
    {appInfo?.updatesSupported && <UpdateSettings updates={updates} onInstall={onInstallUpdate} />}
    <p className="settings-version">PWTools {appInfo && appInfo.version !== '浏览器预览' ? `v${appInfo.version}` : ''}</p>
  </div>;
}
