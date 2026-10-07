import { NumberInput } from '@mantine/core';
import type { OrderInput } from '../shared/contracts';
import RentalSelect from './RentalSelect';
import { MAX_CENTS, moneyText, orderNetCents } from './rentalPresentation';
import './rentals.css';

export default function OrderFinanceFields({ input, onChange, disabled, required, onError, onRentalReadyChange }: { input: OrderInput; onChange: (input: Partial<OrderInput>) => void; disabled: boolean; required: boolean; onError: (error: unknown) => boolean; onRentalReadyChange: (ready: boolean) => void }) {
  const people = input.participant_count ?? 1;
  const commission = input.commission_bps ?? 0;
  const ready = input.price_cents != null && Number.isSafeInteger(input.price_cents) && Number.isInteger(people) && people >= 1 && people <= 100 && Number.isInteger(commission) && commission >= 0 && commission <= 10_000;
  const patchFinance = (values: Partial<OrderInput>) => onChange({ participant_count: people, commission_bps: commission, ...values });
  return <section className="order-finance" aria-label="订单收入与默认用号"><h3>订单收入</h3>
    <div className="ledger-form-two"><NumberInput label="订单总价（元）" required={required} min={0} max={MAX_CENTS / 100} decimalScale={2} hideControls value={input.price_cents == null ? '' : input.price_cents / 100} disabled={disabled} onChange={value => patchFinance({ price_cents: value === '' ? null : Math.round(Number(value) * 100) })} /><NumberInput label="接单人数（均分）" required min={1} max={100} allowDecimal={false} hideControls value={people} disabled={disabled} onChange={value => patchFinance({ participant_count: value === '' ? 0 : Number(value) })} /></div>
    <div className="ledger-form-two"><NumberInput label="抽成扣除（%）" required min={0} max={100} decimalScale={2} hideControls value={commission / 100} disabled={disabled} onChange={value => patchFinance({ commission_bps: Math.round(Number(value) * 100) })} /><NumberInput label="本人到手（%）" required min={0} max={100} decimalScale={2} hideControls value={(10_000 - commission) / 100} disabled={disabled} onChange={value => patchFinance({ commission_bps: 10_000 - Math.round(Number(value) * 100) })} /></div>
    <p className="order-finance-preview" aria-live="polite">{ready ? <>每人分得 {moneyText(Math.round(input.price_cents! / people))}，本人扣抽成后应得 <strong>{moneyText(orderNetCents(input.price_cents!, people, commission))}</strong></> : '填写收入信息后，结单时按各账号参与的局数分摊。'}</p>
    <RentalSelect label="默认使用账号" activeOnly value={input.default_rental_session_id ?? null} onChange={id => onChange({ default_rental_session_id: id })} disabled={disabled} onError={onError} onReadyChange={onRentalReadyChange} /><p className="order-finance-preview">仅用于记一场时预填，每局可选择实际使用的账号。</p>
  </section>;
}
