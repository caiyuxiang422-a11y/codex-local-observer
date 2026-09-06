import type { MediumCrownStatusTone } from "./crownOverlayModel";
import { localized, useAppLocale, type AppLocale } from "./locale";

export function mediumCrownStatusTone(status: string): MediumCrownStatusTone {
  const normalized = status.toLocaleLowerCase();
  if (status.includes("失败") || /\b(failed|failure|error)\b/.test(normalized)) {
    return "error";
  }
  if (status.includes("待批准") || /\b(awaiting approval|approval required)\b/.test(normalized)) {
    return "warning";
  }
  if (
    status.includes("运行") ||
    status.includes("同步") ||
    status.includes("读取") ||
    /\b(running|syncing|reading|loading)\b/.test(normalized)
  ) {
    return "active";
  }
  return "idle";
}

export function mediumCrownCopy(locale: AppLocale) {
  return {
    statusPrefix: localized(locale, "当前状态：", "Current status: "),
    remainingLabel: localized(locale, "Usage 余量", "Usage remaining"),
    remainingAria: localized(locale, "Usage 剩余比例", "Usage remaining percentage"),
  } as const;
}

export function MediumCrown({
  projectName,
  status,
  statusTone = mediumCrownStatusTone(status),
  remainingValue,
  remainingPercent,
  ariaHidden = false,
}: {
  projectName: string;
  status: string;
  statusTone?: MediumCrownStatusTone;
  remainingValue: string;
  remainingPercent?: number;
  ariaHidden?: boolean;
}) {
  const locale = useAppLocale();
  const copy = mediumCrownCopy(locale);
  return (
    <header
      className="widget-medium-crown"
      data-status-tone={statusTone}
      aria-hidden={ariaHidden || undefined}
    >
      <div className="widget-medium-crown-wing widget-medium-crown-wing--left">
        <i className="widget-medium-status-dot" aria-hidden="true" />
        <div>
          <strong title={projectName}>{projectName}</strong>
          <small title={`${copy.statusPrefix}${status}`}>{status}</small>
        </div>
      </div>
      <span className="widget-medium-crown-camera" aria-hidden="true" />
      <div className="widget-medium-crown-wing widget-medium-crown-wing--right">
        <div className="widget-medium-crown-usage">
          <span>{copy.remainingLabel}</span>
          <strong>{remainingValue}</strong>
        </div>
        <span
          className="widget-medium-crown-meter"
          role={remainingPercent === undefined ? undefined : "progressbar"}
          aria-label={remainingPercent === undefined ? undefined : copy.remainingAria}
          aria-valuemin={remainingPercent === undefined ? undefined : 0}
          aria-valuemax={remainingPercent === undefined ? undefined : 100}
          aria-valuenow={remainingPercent}
        >
          <i style={{ width: `${remainingPercent ?? 0}%` }} />
        </span>
      </div>
    </header>
  );
}
