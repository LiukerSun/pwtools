import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Alert, Button, createTheme, InputWrapper, Loader, MantineProvider, Menu, Modal, PasswordInput, SegmentedControl, Select, Textarea, TextInput, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { Notifications, notifications } from '@mantine/notifications';
import { BookOpen, ChevronDown, LogOut, Mail, Maximize2, Minus, Moon, PanelLeftClose, PanelLeftOpen, Settings2, Sun, X } from 'lucide-react';
import type { AppInfo, User } from '../shared/contracts';
import { api, errorInfo, isDesktop, isSessionError } from './api';
import BossLedger from './BossLedger';

type PageId = 'dashboard' | 'settings';
type ThemeMode = 'dark' | 'light';
type Connection = 'checking' | 'connected' | 'failed';

const uiTheme = createTheme({
  primaryColor: 'indigo',
  colors: { indigo: ['#EDF9FE', '#D6EFF9', '#B6E3F3', '#96D7EF', '#7ACDEB', '#52B1D2', '#308EAD', '#226E89', '#20586B', '#174354'] },
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
  },
});

const pages = [
  { id: 'dashboard' as const, label: '老板账本', icon: BookOpen },
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

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [connection, setConnection] = useState<Connection>('checking');
  const [restoreError, setRestoreError] = useState('');
  const checkingRef = useRef(false);
  const workspaceCloseRef = useRef<(() => void) | null>(null);
  const registerWindowClose = useCallback((handler: (() => void) | null) => { workspaceCloseRef.current = handler; }, []);
  const requestWindowClose = useCallback(() => {
    if (workspaceCloseRef.current) { workspaceCloseRef.current(); return; }
    void api.windowControl('close').catch((error: unknown) => {
      notifications.show({ title: '关闭未完成', message: errorInfo(error).message, color: 'red' });
    });
  }, []);

  useEffect(() => api.onCloseRequested?.(requestWindowClose), [requestWindowClose]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
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
    setUser(currentUser);
    setRestoreError('');
    void checkConnection();
  };

  return <MantineProvider theme={uiTheme} forceColorScheme={theme}>
    <Notifications position="top-right" autoClose={2400} limit={2} containerWidth={360} />
    <div className="app-root">
      <TitleBar onClose={requestWindowClose} />
      {restoring ? <div className="restore-screen"><BrandMark /><Loader size="sm" /></div> : user ? <Workspace key={user.id} user={user} onSignedOut={() => setUser(null)} onError={handleError} theme={theme} onThemeChange={setTheme} appInfo={appInfo} onCloseHandlerChange={registerWindowClose} /> : <AuthScreen onAuthenticated={authenticated} connection={connection} restoreError={restoreError} />}
    </div>
  </MantineProvider>;
}

function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'small' : ''}`}><BookOpen size={small ? 19 : 25} strokeWidth={1.8} /></span>;
}

function TitleBar({ onClose }: { onClose: () => void }) {
  return <div className="titlebar">
    <div className="titlebar-brand"><BookOpen size={14} /><span>PWTools</span></div>
    {isDesktop ? <div className="window-controls">
      <button aria-label="最小化窗口" onClick={() => void api.windowControl('minimize')}><Minus size={15} /></button>
      <button aria-label="最大化或还原窗口" onClick={() => void api.windowControl('maximize')}><Maximize2 size={13} /></button>
      <button className="window-close" aria-label="关闭窗口" onClick={onClose}><X size={16} /></button>
    </div> : <span className="preview-label">浏览器预览</span>}
  </div>;
}

interface AuthProps { onAuthenticated: (user: User) => void; connection: Connection; restoreError: string }

function AuthScreen({ onAuthenticated, connection, restoreError }: AuthProps) {
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
      <div className="auth-brand"><BrandMark /><strong>PWTools</strong></div>
      <div className="auth-form-content" key={mode}>
        <div className="auth-form-heading"><h1>{mode === 'login' ? '登录' : '注册'}</h1></div>
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
    </section>
  </main>;
}

interface WorkspaceProps {
  user: User; onSignedOut: () => void;
  onError: (error: unknown) => boolean; theme: ThemeMode; onThemeChange: (theme: ThemeMode) => void;
  appInfo: AppInfo | null;
  onCloseHandlerChange: (handler: (() => void) | null) => void;
}

function Workspace({ user, onSignedOut, onError, theme, onThemeChange, appInfo, onCloseHandlerChange }: WorkspaceProps) {
  const [page, setPage] = useState<PageId>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [ledgerVisit, setLedgerVisit] = useState(0);
  const ledgerNavigationRef = useRef({ dirty: false, busy: false });
  const pageRef = useRef(page);
  pageRef.current = page;
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [pendingClose, setPendingClose] = useState(false);
  const allowCloseRef = useRef(false);
  const reportLedgerNavigation = useCallback((state: { dirty: boolean; busy: boolean }) => { ledgerNavigationRef.current = state; }, []);
  const [signingOut, setSigningOut] = useState(false);
  const signingOutRef = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const completeWindowClose = useCallback(() => {
    allowCloseRef.current = true;
    void api.windowControl('close').catch((error: unknown) => {
      allowCloseRef.current = false;
      notifications.show({ title: '关闭未完成', message: errorInfo(error).message, color: 'red' });
    });
  }, []);
  const requestWindowClose = useCallback(() => {
    const state = pageRef.current === 'dashboard' ? ledgerNavigationRef.current : { dirty: false, busy: false };
    if (state.busy || signingOutRef.current) {
      notifications.show({ title: '当前操作尚未完成', message: '请等待保存结果', color: 'orange' });
      return;
    }
    if (state.dirty) {
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
      const state = pageRef.current === 'dashboard' ? ledgerNavigationRef.current : { dirty: false, busy: false };
      if (!state.dirty && !state.busy && !signingOutRef.current) return;
      event.preventDefault();
      event.returnValue = 'pending';
      requestWindowClose();
    };
    window.addEventListener('beforeunload', protectWindow);
    return () => window.removeEventListener('beforeunload', protectWindow);
  }, [requestWindowClose]);
  const currentPage = pages.find(item => item.id === page)!;
  const runNavigation = (action: () => void) => {
    const currentNavigation = page === 'dashboard' ? ledgerNavigationRef.current : { dirty: false, busy: false };
    if (currentNavigation.busy) {
      notifications.show({ message: '请等待保存或识别完成', color: 'orange' });
      return;
    }
    if (currentNavigation.dirty) { setPendingClose(false); setPendingNavigation(() => action); return; }
    action();
  };
  const navigatePage = (nextPage: PageId) => runNavigation(() => {
    if (nextPage === 'dashboard') setLedgerVisit(value => value + 1);
    setPage(nextPage);
  });
  const logout = async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true; setSigningOut(true);
    try { await api.logout(); onSignedOut(); }
    catch (error) { if (!onError(error)) notifications.show({ title: '退出未完成', message: errorInfo(error).message, color: 'red' }); }
    finally { signingOutRef.current = false; setSigningOut(false); }
  };
  return <div className="workspace">
    <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand-row"><div className="sidebar-brand"><BrandMark small /><div><strong>PWTools</strong></div></div><Tooltip label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} position="right"><button className="sidebar-toggle" aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!sidebarCollapsed} aria-controls="pw-sidebar-navigation" onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button></Tooltip></div>
      <nav className="main-nav" id="pw-sidebar-navigation" aria-label="主导航" style={{ '--nav-index': pages.findIndex(item => item.id === page) } as CSSProperties}>
        <span className="nav-active-rail" aria-hidden="true" />
        {pages.map(({ id, label, icon: Icon }) => <Tooltip key={id} label={label} position="right" disabled={!sidebarCollapsed}><button className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigatePage(id)} aria-label={label} aria-current={page === id ? 'page' : undefined}><Icon size={20} /><span className="nav-text">{label}</span></button></Tooltip>)}
      </nav>
    </aside>
    <div className="workspace-body">
      <header className="workspace-header">
        <div className="header-actions"><Tooltip label={theme === 'dark' ? '切换至浅色' : '切换至深色'}><button className="header-theme-toggle" aria-label={theme === 'dark' ? '切换至浅色' : '切换至深色'} onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></Tooltip><Menu position="bottom-end" shadow="md" transitionProps={{ transition: 'pop-top-right', duration: 160 }}><Menu.Target><button className="account-menu" aria-label="账号菜单"><Mail size={15} /><span title={user.email}>{user.email}</span><ChevronDown size={13} /></button></Menu.Target><Menu.Dropdown className="account-dropdown"><Menu.Label>{user.email}</Menu.Label><Menu.Item color="red" leftSection={<LogOut size={15} />} onClick={() => runNavigation(() => void logout())} disabled={signingOut}>退出登录</Menu.Item></Menu.Dropdown></Menu></div>
      </header>
      <main className="page-main" ref={mainRef}>
        <div className="page-heading"><h1 tabIndex={-1}>{currentPage.label}</h1></div>
        <div className="page-transition" key={page}>
          {page === 'dashboard' && <BossLedger key={ledgerVisit} onError={onError} onNavigationStateChange={reportLedgerNavigation} />}
          {page === 'settings' && <Settings theme={theme} onThemeChange={onThemeChange} appInfo={appInfo} onLogout={() => runNavigation(() => void logout())} signingOut={signingOut} email={user.email} />}
        </div>
      </main>
    </div>
    <Modal classNames={{ content: 'navigation-guard-modal' }} opened={pendingNavigation !== null} onClose={() => setPendingNavigation(null)} title="尚有未保存修改" centered size="sm" zIndex={400}>
      <p>离开将丢弃未保存内容。</p>
      <div className="navigation-guard-actions"><Button variant="default" onClick={() => setPendingNavigation(null)}>继续填写</Button><Button onClick={() => {
        if (ledgerNavigationRef.current.busy || signingOutRef.current) {
          notifications.show({ message: '请等待保存结果', color: 'orange' });
          return;
        }
        const action = pendingNavigation;
        setPendingNavigation(null);
        reportLedgerNavigation({ dirty: false, busy: false });
        action?.();
      }}>放弃修改并{pendingClose ? '关闭' : '切换'}</Button></div>
    </Modal>
  </div>;
}

function Settings({ theme, onThemeChange, appInfo, onLogout, signingOut, email }: { theme: ThemeMode; onThemeChange: (theme: ThemeMode) => void; appInfo: AppInfo | null; onLogout: () => void; signingOut: boolean; email: string }) {
  return <div className="settings-layout">
    <section className="panel settings-section"><div className="section-heading"><h2>外观</h2></div><div className="settings-row"><strong>主题</strong><SegmentedControl value={theme} onChange={(value) => onThemeChange(value as ThemeMode)} data={[{ value: 'dark', label: <span className="theme-label"><Moon size={14} /> 深色</span> }, { value: 'light', label: <span className="theme-label"><Sun size={14} /> 浅色</span> }]} /></div></section>
    <section className="panel settings-section"><div className="section-heading"><h2>账号</h2></div><div className="settings-row"><div><strong className="settings-email">{email}</strong>{!appInfo?.persistentSession && <p>关闭后需重新登录</p>}</div><Button variant="default" color="red" leftSection={<LogOut size={15} />} loading={signingOut} onClick={onLogout}>退出登录</Button></div></section>
    <p className="settings-version">PWTools {appInfo && appInfo.version !== '浏览器预览' ? `v${appInfo.version}` : ''}</p>
  </div>;
}
