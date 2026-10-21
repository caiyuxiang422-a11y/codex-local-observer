import { rateLimitWindows, type RateLimitBucket } from "./accountModel";
import { intlLocale, localized, useAppLocale } from "./locale";
import "./QuotaWindows.css";

export function QuotaWindows({ bucket }: { bucket: RateLimitBucket | undefined }) {
  const locale = useAppLocale();
  const windows = rateLimitWindows(bucket);
  if (windows.length < 2) return null;
  return (
    <div className="quota-windows" aria-label={localized(locale, "全部额度窗口", "All quota windows")}>
      {windows.map((window, index) => {
        const minutes = window.windowDurationMins;
        const period = !minutes
          ? localized(locale, index === 0 ? "主窗口" : "第二窗口", index === 0 ? "Primary window" : "Secondary window")
          : minutes % 10080 === 0
            ? localized(locale, `${minutes / 10080} 周`, `${minutes / 10080}-week`)
            : minutes % 60 === 0
              ? localized(locale, `${minutes / 60} 小时`, `${minutes / 60}-hour`)
              : localized(locale, `${minutes} 分钟`, `${minutes}-minute`);
        const reset = window.resetsAt === undefined
          ? localized(locale, "重置时间未知", "Reset time unknown")
          : localized(locale, "重置 ", "Resets ") + new Intl.DateTimeFormat(intlLocale(locale), {
            month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
          }).format(window.resetsAt * 1000);
        return (
          <div className="quota-window" key={index} data-exhausted={window.remainingPercent === 0}>
            <div><span title={period}>{period}</span><strong>{window.remainingPercent === undefined ? "—" : `${window.remainingPercent}%`}</strong></div>
            <small>{reset}</small>
          </div>
        );
      })}
    </div>
  );
}
