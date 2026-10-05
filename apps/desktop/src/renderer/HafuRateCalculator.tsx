import { Button, NumberInput } from '@mantine/core';
import { RotateCcw } from 'lucide-react';
import { calculateHafuRate, emptyHafuRateInput, type HafuRateInput } from './hafuRate';
import './hafu-rate.css';

const moneyFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface HafuRateCalculatorProps {
  input: HafuRateInput;
  onChange: (input: HafuRateInput) => void;
}

export default function HafuRateCalculator({ input, onChange }: HafuRateCalculatorProps) {
  const { errors, result } = calculateHafuRate(input);
  const hasInput = Object.values(input).some(value => value !== '');
  const hasInvalidInput = Object.entries(errors).some(([field]) => input[field as keyof HafuRateInput] !== '');
  const patch = (field: keyof HafuRateInput, value: number | string) => onChange({ ...input, [field]: value });

  return <div className="hafu-rate-calculator">
    <section className="panel hafu-rate-inputs" aria-labelledby="hafu-rate-input-heading">
      <div className="section-heading">
        <h2 id="hafu-rate-input-heading">订单信息</h2>
        <Button variant="subtle" size="xs" disabled={!hasInput} leftSection={<RotateCcw size={14} aria-hidden="true" />} onClick={() => onChange({ ...emptyHafuRateInput })}>清空</Button>
      </div>
      <div className="hafu-rate-fields">
        <NumberInput label="订单价格（元）" required placeholder="填写订单总价" size="md" inputMode="decimal" hideControls min={0} clampBehavior="none" decimalScale={2} thousandSeparator="," value={input.orderPrice} onChange={value => patch('orderPrice', value)} error={input.orderPrice !== '' ? errors.orderPrice : undefined} />
        <NumberInput label="保底金额（W）" required description="1 W = 1 万哈夫币，例如 1000 万填 1000。" placeholder="填写保底哈夫币数量" size="md" inputMode="decimal" hideControls min={0} clampBehavior="none" decimalScale={4} thousandSeparator="," value={input.guaranteedWan} onChange={value => patch('guaranteedWan', value)} error={input.guaranteedWan !== '' ? errors.guaranteedWan : undefined} />
        <NumberInput label="陪玩抽成（%）" required description="填写陪玩实际拿到的比例，例如拿八成填 80。" placeholder="自行填写 0–100" size="md" inputMode="decimal" hideControls min={0} max={100} clampBehavior="none" decimalScale={2} value={input.commissionPercent} onChange={value => patch('commissionPercent', value)} error={input.commissionPercent !== '' ? errors.commissionPercent : undefined} />
      </div>
    </section>

    <section className="panel hafu-rate-result" aria-labelledby="hafu-rate-result-heading">
      <div className="hafu-rate-primary">
        <h2 id="hafu-rate-result-heading">陪玩到手汇率</h2>
        <output className="hafu-rate-output" aria-label="陪玩到手汇率" aria-live="polite" aria-atomic="true">
          <strong>{result ? moneyFormat.format(result.receivedRate) : '—'}</strong>
          <span>元 / 1000W 哈夫币</span>
        </output>
        <p>{result ? '已按你填写的陪玩抽成折算' : hasInvalidInput ? '请修正输入后查看汇率' : '填写三项订单信息后自动计算'}</p>
      </div>
      <div className="hafu-rate-breakdown">
        <dl>
          <div><dt>本单陪玩到手</dt><dd>{result ? `${moneyFormat.format(result.receivedAmount)} 元` : '—'}</dd></div>
          <div><dt>订单原价汇率</dt><dd>{result ? `${moneyFormat.format(result.orderRate)} 元 / 1000W` : '—'}</dd></div>
        </dl>
        <div className="hafu-rate-formula">
          <h3>计算方式</h3>
          <p>订单价格 ×（陪玩抽成 ÷ 100）÷ 保底金额（W）× 1000</p>
          <p>抽成按百分比计算，结果保留两位小数。</p>
        </div>
      </div>
    </section>
  </div>;
}
