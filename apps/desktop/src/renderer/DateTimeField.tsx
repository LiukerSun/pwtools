import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DateTimePicker } from '@mantine/dates';
import { CalendarDays, Check } from 'lucide-react';
import 'dayjs/locale/zh-cn';
import '@mantine/dates/styles.css';
import './date-time-field.css';

export interface DateTimeFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: ReactNode;
  disabled?: boolean;
  onOpenChange?: (opened: boolean) => void;
}

const beijingFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function beijingNow(): string {
  const parts = beijingFormat.formatToParts(new Date());
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === name)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function dayLabel(date: string): string {
  return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

export default function DateTimeField({ label, value, onChange, error, disabled = false, onOpenChange }: DateTimeFieldProps) {
  const [now, setNow] = useState(beijingNow);
  const [opened, setOpened] = useState(false);
  const openedRef = useRef(false);
  const openCallback = useRef(onOpenChange);
  openCallback.current = onOpenChange;
  const reportOpen = useCallback((next: boolean) => {
    if (openedRef.current === next) return;
    openedRef.current = next;
    setOpened(next);
    openCallback.current?.(next);
  }, []);

  useEffect(() => {
    if (!opened) return;
    const timer = window.setInterval(() => setNow(beijingNow()), 1000);
    return () => window.clearInterval(timer);
  }, [opened]);
  useEffect(() => { if (disabled) reportOpen(false); }, [disabled, reportOpen]);
  useEffect(() => () => { if (openedRef.current) openCallback.current?.(false); }, []);

  // Mantine uses wall-clock strings; converting separators never shifts Beijing time.
  const pickerValue = value ? `${value.replace('T', ' ')}:00` : null;
  return <DateTimePicker
    className="date-time-field"
    label={label}
    value={pickerValue}
    onChange={(next) => onChange(next ? next.slice(0, 16).replace(' ', 'T') : '')}
    valueFormat="YYYY年M月D日 HH:mm"
    placeholder="留空使用保存时间"
    locale="zh-cn"
    firstDayOfWeek={1}
    monthLabelFormat="YYYY年M月"
    yearLabelFormat="YYYY年"
    monthsListFormat="M月"
    weekdayFormat="dd"
    defaultDate={value ? value.slice(0, 10) : now.slice(0, 10)}
    defaultTimeValue={value ? value.slice(11, 16) : now.slice(11, 16)}
    presets={[{ label: '现在', value: `${now.replace('T', ' ')}:00` }]}
    getDayProps={(date) => ({ 'aria-label': dayLabel(date) })}
    ariaLabels={{ nextMonth: '下个月', previousMonth: '上个月', nextYear: '下一年', previousYear: '上一年', nextDecade: '下十年', previousDecade: '上十年', monthLevelControl: '选择月份', yearLevelControl: '选择年份' }}
    size="md"
    error={error}
    disabled={disabled}
    withSeconds={false}
    clearable
    clearSectionMode="both"
    clearButtonProps={{ 'aria-label': `清空${label}` }}
    rightSection={<CalendarDays size={16} aria-hidden="true" />}
    rightSectionPointerEvents="none"
    classNames={{ input: 'date-time-field-input', timeWrapper: 'date-time-time-row', submitButton: 'date-time-confirm' }}
    onClick={() => { if (!openedRef.current) setNow(beijingNow()); }}
    onDropdownClose={() => reportOpen(false)}
    timePickerProps={{ format: '24h', hoursStep: 1, minutesStep: 1, hoursInputLabel: '小时', minutesInputLabel: '分钟', label: '北京时间', disabled: disabled || !value }}
    submitButtonProps={{ 'aria-label': '确定时间', title: '确定时间', disabled: disabled || !value, children: <Check size={16} /> }}
    popoverProps={{
      withinPortal: true, zIndex: 350, position: 'bottom-start', returnFocus: true,
      onOpen: () => reportOpen(true), onClose: () => reportOpen(false),
      classNames: { dropdown: 'date-time-popover' },
      attributes: { dropdown: { 'aria-label': `选择${label}`, 'aria-labelledby': undefined } },
      transitionProps: { duration: 120 },
    }}
  />;
}
