export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface LoginInput { email: string; password: string }
export type RegisterInput = LoginInput;
export interface AuthResponse { token: string; user: User }
export interface HealthResponse { status: 'ok'; database: 'connected' }
export interface AppInfo { version: string; apiUrl: string; persistentSession: boolean; updatesSupported?: boolean }
export interface UpdateState {
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'download-error' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  currentChannel: 'stable' | 'beta';
  betaEnabled: boolean;
  latestChannel: 'stable' | 'beta' | null;
  latestVersion: string | null;
  downloadedBytes: number;
  totalBytes: number;
  notes: string;
  publishedAt: string;
  error: string;
}
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
  rental_session_id?: string | null;
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
export type MatchUpdateInput = Pick<MatchRecord, 'player_name' | 'outcome' | 'amount' | 'confirmed' | 'played_at' | 'note'> & { failure_extra_amount?: number; fake_amount?: number | null; order_id?: string; rental_session_id?: string | null };
export interface MatchUploadInput { name: string; content_type: string; data: Uint8Array; order_id?: string }
export interface ImportHotkey { code: string; ctrl: boolean; alt: boolean; shift: boolean; win: boolean }
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
  price_cents?: number | null;
  participant_count?: number | null;
  commission_bps?: number | null;
  default_rental_session_id?: string | null;
  title: string;
  kind: OrderKind;
  target_quantity: number;
  failure_default_quantity: number;
  failure_trigger?: FailureTrigger;
  failure_standard_quantity?: number;
  failure_mode?: FailureMode;
  note: string;
}
export interface OrderSettlement {
  id: string; mode: 'waiver' | 'refund' | 'completed'; original_income_cents: number;
  final_income_cents: number; note: string; archived_at: string; restored_at: string | null;
}
export interface OrderArchiveInput {
  id: string; mode: OrderSettlement['mode']; final_income_cents: number; note: string; expected_updated_at: string;
}
export interface OrderTransferInput {
  id: string;
  prepaid: boolean;
  progress_bps: number | null;
  note: string;
  expected_updated_at: string;
}
export type OrderTransferAction = 'settle' | 'cancel' | 'refund' | 'confirm_refund';
export interface OrderTransferActionInput {
  id: string;
  transfer_id: string;
  action: OrderTransferAction;
  amount_cents?: number;
  final_income_cents?: number;
  mode?: 'refund' | 'waiver';
  note: string;
  expected_updated_at: string;
}
export interface TransferCashEvent {
  id: string;
  kind: 'settlement' | 'refund';
  direction: 'receipt' | 'payment';
  amount_cents: number;
  note: string;
  created_at: string;
}
export interface TransferEvent {
  id: string;
  action: OrderTransferAction;
  amount_cents: number | null;
  final_income_cents: number | null;
  mode: 'refund' | 'waiver' | null;
  note: string;
  created_at: string;
}
export interface OrderTransfer {
  id: string;
  prepaid: boolean;
  progress_bps: number | null;
  progress_numerator: number;
  progress_denominator: number;
  original_income_cents: number;
  expected_income_cents: number;
  expected_cash_cents: number;
  agreed_income_cents: number;
  amount_due_cents: number;
  final_income_cents: number | null;
  pending_refund_cents: number;
  status: 'pending' | 'settled' | 'waived' | 'cancelled';
  refund_mode: 'refund' | 'waiver' | null;
  note: string;
  created_at: string;
  settled_at: string | null;
  cancelled_at: string | null;
  cash_events: TransferCashEvent[];
  events: TransferEvent[];
  original_order: Pick<ServiceOrder, 'title' | 'kind' | 'price_cents' | 'participant_count' | 'commission_bps' | 'completed_quantity' | 'total_quantity' | 'target_quantity' | 'failure_quantity' | 'adjustment_quantity'>;
}
export interface ServiceOrder extends OrderInput {
  transfer_history?: OrderTransfer[];
  archived_at?: string | null;
  settlement_required?: boolean;
  settlement_history?: OrderSettlement[];
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
  status: 'active' | 'completed' | 'archived';
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
  rental_session_id?: string | null;
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
  rental_session_id?: string | null;
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

export interface RentalAccountInput { id: string; name: string; note: string }
export interface RentalAccount extends RentalAccountInput { created_at: string; updated_at: string }
export interface RentalSessionInput {
  id: string;
  account_id: string;
  coin_per_yuan: number;
  /** Equipment quotes use 1/10000 yuan; preserve the scale used by earlier clients. */
  aw_price: number;
  helmet_price: number;
  armor_price: number;
  initial_coins: number;
  deposit_cents: number;
  started_at: string;
  note: string;
}
export interface RentalSession extends RentalSessionInput {
  account_name: string;
  returned_at: string | null;
  final_cost_cents: number | null;
  round_count: number;
  created_at: string;
  updated_at: string;
}
export interface RentalReturnInput { final_cost_cents: number; returned_at?: string | null }
export interface RentalOrderAnalysis {
  original_income_cents: number | null;
  lost_income_cents: number | null;
  settlement_mode: OrderSettlement['mode'] | 'transfer' | null;
  order_id: string;
  title: string;
  boss_name: string;
  order_status: 'active' | 'completed' | 'archived';
  rental_rounds: number;
  total_rounds: number;
  order_income_cents: number | null;
  income_cents: number | null;
  income_status: 'settled' | 'pending' | 'missing_finance';
}
export interface RentalAnalysis {
  original_income_cents: number;
  lost_income_cents: number;
  affected_order_count: number;
  affected_round_count: number;
  original_profit_cents: number | null;
  session: RentalSession;
  orders: RentalOrderAnalysis[];
  round_count: number;
  order_count: number;
  pending_order_count: number;
  income_cents: number;
  profit_cents: number | null;
  refund_cents: number | null;
  supplement_cents: number | null;
}

export interface DesktopBridge {
  listBuildCodes(): Promise<{ items: WeaponBuildCode[] }>;
  createBuildCode(input: WeaponBuildCodeInput): Promise<WeaponBuildCode>;
  updateBuildCode(id: string, input: WeaponBuildCodeInput): Promise<WeaponBuildCode>;
  deleteBuildCode(id: string): Promise<void>;
  lookupBuildCode(input: WeaponBuildCodeInput): Promise<BuildCodeLookup>;
  recognizeBuildCodeAttributes(image: BuildAttributeImage): Promise<BuildAttributeCandidate>;
  listRentalAccounts(): Promise<{ items: RentalAccount[] }>;
  createRentalAccount(input: RentalAccountInput): Promise<RentalAccount>;
  listRentalSessions(): Promise<{ items: RentalSession[] }>;
  createRentalSession(input: RentalSessionInput): Promise<RentalSession>;
  returnRentalSession(id: string, input: RentalReturnInput): Promise<RentalSession>;
  rentalAnalysis(id: string): Promise<RentalAnalysis>;
  health(): Promise<HealthResponse>;
  register(input: RegisterInput): Promise<User>;
  login(input: LoginInput): Promise<User>;
  me(): Promise<User>;
  logout(): Promise<void>;
  windowControl(action: 'minimize' | 'hide-to-tray' | 'maximize' | 'restore' | 'close'): Promise<void>;
  setWindowTheme(theme: 'dark' | 'light'): Promise<void>;
  setImportHotkey(shortcut: ImportHotkey | null): Promise<void>;
  captureScreen(): Promise<MatchUploadInput | null>;
  readClipboardImage(): Promise<MatchUploadInput | null>;
  appInfo(): Promise<AppInfo>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  setBetaParticipation(enabled: boolean): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  onCloseRequested?(handler: () => void): () => void;
  onExitRequested?(handler: () => void): () => void;
  onImportRequested?(handler: () => void): () => void;
  confirmMatch(image: MatchUploadInput, input: MatchUpdateInput, record: MatchRecord): Promise<MatchUploadResponse>;
  uploadMatch(input: MatchUploadInput): Promise<MatchUploadResponse>;
  listMatches(page?: number, pageSize?: number, orderId?: string, confirmed?: boolean): Promise<MatchListResponse>;
  matchStats(orderId?: string): Promise<MatchStats>;
  getMatch(id: string): Promise<MatchRecord>;
  updateMatch(id: string, input: MatchUpdateInput): Promise<MatchRecord>;
  recognizeMatch(id: string): Promise<MatchRecord>;
  deleteMatch(id: string): Promise<void>;
  matchImage(id: string): Promise<MatchImage>;
  matchThumbnail(id: string): Promise<MatchImage>;
  matchSettings(): Promise<MatchSettings>;
  updateMatchSettings(input: MatchSettings): Promise<MatchSettings>;
  listBosses(search?: string): Promise<{ items: Boss[] }>;
  getBoss(id: string): Promise<Boss>;
  createBoss(input: BossInput): Promise<Boss>;
  updateBoss(id: string, input: BossInput): Promise<Boss>;
  archiveOrder(id: string, input: OrderArchiveInput): Promise<ServiceOrder>;
  restoreOrder(id: string, settlementId: string): Promise<ServiceOrder>;
  transferOrder(id: string, input: OrderTransferInput): Promise<ServiceOrder>;
  transferOrderAction(id: string, input: OrderTransferActionInput): Promise<ServiceOrder>;
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

export interface BuildAttributeValues {
  damage?: number | null; armor_damage?: number | null; range_m?: number | null;
  recoil_control?: number | null; handling?: number | null; stability?: number | null; hip_fire?: number | null;
  fire_rate_rpm?: number | null; capacity?: number | null; fire_modes?: ('全自动' | '单发' | '点射')[] | null;
  muzzle_velocity_mps?: number | null; sound_distance_m?: number | null; price?: number | null;
}
export interface BuildIdentity { weapon_name: string; mode: '烽火地带' | '全面战场'; core_code: string }
export interface ManualBuildAttributes {
  identity: BuildIdentity; values: BuildAttributeValues; source: 'manual' | 'ocr_confirmed'; recognized_at?: string | null;
  confirmed_at: string;
}
export type ManualBuildAttributeInput = Omit<ManualBuildAttributes, 'confirmed_at'> & { confirmed: boolean };
export interface BuildAttributeCandidate {
  status: 'completed' | 'no_text' | 'no_fields'; weapon_name: string | null; values: BuildAttributeValues;
  confidences: Partial<Record<keyof BuildAttributeValues, number>>; warnings: string[]; missing: string[];
}
export interface BuildAttributeImage { name: string; content_type: string; data_base64: string }
export interface WeaponBuildCodeInput { code: string; weapon_name: string; mode: '烽火地带' | '全面战场'; note: string; manual_attributes?: ManualBuildAttributeInput | null; record_id?: string }
export interface BuildCodeAttributes {
  source: string;
  fetched_at: string;
  provider_id: number | null;
  price: number | null;
  properties: { name: string; value: number; change: string; unit?: string }[];
  snapshot_source?: 'manual' | 'ocr_confirmed'; recognized_at?: string | null; details?: BuildAttributeValues;
}
export type BuildCodeLookupStatus = 'matched' | 'unmatched' | 'unavailable' | 'not_configured';
export interface BuildCodeLookup { status: BuildCodeLookupStatus; attributes: BuildCodeAttributes | null }
export interface WeaponBuildCode extends Omit<WeaponBuildCodeInput, 'manual_attributes'> {
  id: string;
  attributes: BuildCodeAttributes | null;
  lookup_status: BuildCodeLookupStatus;
  created_at: string;
  updated_at: string;
  manual_attributes?: ManualBuildAttributes | null;
  provider_attributes?: BuildCodeAttributes | null;
}
