export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface LoginInput { email: string; password: string }
export type RegisterInput = LoginInput;
export interface AuthResponse { token: string; user: User }
export interface HealthResponse { status: 'ok'; database: 'connected' }
export interface AppInfo { version: string; apiUrl: string; persistentSession: boolean }
export interface ApiErrorData { code: string; message: string }
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ApiErrorData };

export type MatchOutcome = 'success' | 'failed' | 'unknown';
export interface MatchPlayer {
  player_name: string;
  outcome: MatchOutcome;
  amount: number | null;
  confidence: number | null;
}
export interface MatchRecord {
  id: string;
  order_id: string | null;
  failure_extra_amount: number;
  fake_amount: number | null;
  net_amount: number | null;
  credited_amount: number | null;
  boss_id: string;
  boss_player_name: string;
  original_name: string;
  image_content_type: string;
  image_sha256: string;
  image_width: number;
  image_height: number;
  image_size: number;
  players: MatchPlayer[];
  raw_text: string;
  warnings: string[];
  ocr_status: 'completed' | 'failed';
  player_name: string;
  outcome: MatchOutcome;
  amount: number | null;
  confirmed: boolean;
  played_at: string | null;
  note: string;
  created_at: string;
  updated_at: string;
}
export type MatchUpdateInput = Pick<MatchRecord, 'player_name' | 'outcome' | 'amount' | 'confirmed' | 'played_at' | 'note'> & { failure_extra_amount?: number; fake_amount?: number | null; order_id?: string };
export interface MatchUploadInput { name: string; content_type: string; data: Uint8Array; order_id?: string }
export interface MatchUploadResponse { record: MatchRecord; duplicate: boolean }
export interface MatchImage { content_type: string; data: Uint8Array }
export interface MatchListResponse { items: MatchRecord[]; total: number; page: number; page_size: number }
export interface MatchStats {
  confirmed_count: number;
  success_count: number;
  failed_count: number;
  draft_count: number;
  total_amount: number;
  success_rate: number;
}
export interface MatchSettings { boss_id: string; boss_player_name: string }

export type OrderKind = 'hourly' | 'escort' | 'single_round';
export type FailureTrigger = 'failed' | 'failed_below_standard' | 'below_standard';
export type FailureMode = 'manual' | 'fixed' | 'shortfall';
export interface BossInput { display_name: string; game_id: string; game_name: string; notes: string }
export interface Boss extends BossInput {
  id: string;
  active_order_count: number;
  remaining_minutes: number;
  remaining_amount: number;
  pending_single_round_count: number;
  created_at: string;
  updated_at: string;
}
export interface OrderInput {
  title: string;
  kind: OrderKind;
  target_quantity: number;
  failure_default_quantity: number;
  failure_trigger?: FailureTrigger;
  failure_standard_quantity?: number;
  failure_mode?: FailureMode;
  note: string;
}
export interface ServiceOrder extends OrderInput {
  failure_trigger: FailureTrigger;
  failure_standard_quantity: number;
  failure_mode: FailureMode;
  configuration_locked: boolean;
  best_round_quantity: number;
  id: string;
  boss_id: string;
  boss_name: string;
  boss_game_name: string;
  completed_quantity: number;
  failure_quantity: number;
  adjustment_quantity: number;
  total_quantity: number;
  remaining_quantity: number;
  excess_quantity: number;
  status: 'active' | 'completed';
  record_count: number;
  created_at: string;
  updated_at: string;
}
export type OrderTemplateInput = OrderInput & { name: string };
export interface OrderTemplate extends OrderTemplateInput {
  id: string;
  failure_trigger: FailureTrigger;
  failure_standard_quantity: number;
  failure_mode: FailureMode;
  created_at: string;
  updated_at: string;
}
export type LedgerEntryKind = 'progress' | 'failure' | 'adjustment';
export interface LedgerEntry {
  id: string;
  order_id: string;
  kind: LedgerEntryKind;
  quantity: number;
  amount: number | null;
  fake_amount: number | null;
  net_amount: number | null;
  credited_amount: number | null;
  outcome: 'success' | 'failed' | null;
  failure_extra_amount: number;
  occurred_at: string;
  note: string;
  source: 'manual' | 'screenshot';
  match_id: string | null;
}
export interface LedgerEntryInput {
  kind: LedgerEntryKind;
  quantity: number;
  occurred_at: string | null;
  note: string;
  idempotency_key: string;
  amount?: number | null;
  fake_amount?: number | null;
  outcome?: 'success' | 'failed';
  failure_extra_amount?: number;
}
export interface LedgerPage { items: LedgerEntry[]; total: number; page: number; page_size: number }

export interface DesktopBridge {
  health(): Promise<HealthResponse>;
  register(input: RegisterInput): Promise<User>;
  login(input: LoginInput): Promise<User>;
  me(): Promise<User>;
  logout(): Promise<void>;
  windowControl(action: 'minimize' | 'maximize' | 'hide-to-tray' | 'close'): Promise<void>;
  appInfo(): Promise<AppInfo>;
  onCloseRequested?(handler: () => void): () => void;
  onExitRequested?(handler: () => void): () => void;
  uploadMatch(input: MatchUploadInput): Promise<MatchUploadResponse>;
  listMatches(page?: number, pageSize?: number, orderId?: string, confirmed?: boolean): Promise<MatchListResponse>;
  matchStats(orderId?: string): Promise<MatchStats>;
  getMatch(id: string): Promise<MatchRecord>;
  updateMatch(id: string, input: MatchUpdateInput): Promise<MatchRecord>;
  recognizeMatch(id: string): Promise<MatchRecord>;
  deleteMatch(id: string): Promise<void>;
  matchImage(id: string): Promise<MatchImage>;
  matchSettings(): Promise<MatchSettings>;
  updateMatchSettings(input: MatchSettings): Promise<MatchSettings>;
  listBosses(search?: string): Promise<{ items: Boss[] }>;
  getBoss(id: string): Promise<Boss>;
  createBoss(input: BossInput): Promise<Boss>;
  updateBoss(id: string, input: BossInput): Promise<Boss>;
  listOrders(bossId?: string): Promise<{ items: ServiceOrder[] }>;
  getOrder(id: string): Promise<ServiceOrder>;
  createOrder(bossId: string, input: OrderInput): Promise<ServiceOrder>;
  updateOrder(id: string, input: OrderInput): Promise<ServiceOrder>;
  listOrderTemplates(): Promise<{ items: OrderTemplate[] }>;
  createOrderTemplate(input: OrderTemplateInput): Promise<OrderTemplate>;
  updateOrderTemplate(id: string, input: OrderTemplateInput): Promise<OrderTemplate>;
  deleteOrderTemplate(id: string): Promise<void>;
  listLedgerEntries(orderId: string, page?: number, pageSize?: number): Promise<LedgerPage>;
  addLedgerEntry(orderId: string, input: LedgerEntryInput): Promise<LedgerEntry>;
  deleteLedgerEntry(orderId: string, entryId: string): Promise<void>;
}

declare global {
  interface Window { pwtools?: DesktopBridge }
}
