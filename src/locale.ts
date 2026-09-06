import { useSyncExternalStore } from "react";

export type AppLocale = "zh-CN" | "en-US";

export const DEFAULT_APP_LOCALE: AppLocale = "zh-CN";
export const APP_LOCALE_STORAGE_KEY = "codex-local-observer.locale.v1";

const APP_LOCALE_EVENT = "codex-local-observer:locale-change";
const APP_LOCALE_CHANNEL = "codex-local-observer.locale";
const listeners = new Set<() => void>();

let listening = false;
let channel: BroadcastChannel | undefined;
let currentLocale = readStoredLocale();
let lastNativeWindowTitle: string | undefined;

export function normalizeAppLocale(value: unknown): AppLocale {
  return value === "en-US" ? "en-US" : DEFAULT_APP_LOCALE;
}

function readStoredLocale(): AppLocale {
  if (typeof window === "undefined") return DEFAULT_APP_LOCALE;
  try {
    return normalizeAppLocale(window.localStorage.getItem(APP_LOCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_APP_LOCALE;
  }
}

function applyDocumentLocale(locale: AppLocale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
  const params = typeof window === "undefined"
    ? undefined
    : new URLSearchParams(window.location?.search ?? "");
  const isWidget = params?.get("widget") === "1";
  const isCrown = params?.get("crown") === "1";
  const title = isCrown
    ? localized(locale, "Codex 项目概览状态栏", "Codex Project Status")
    : isWidget
      ? localized(locale, "Codex 项目概览", "Codex Project Overview")
      : localized(locale, "Codex 本地观察台", "Codex Local Observer");
  document.title = title;

  if (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    lastNativeWindowTitle !== title
  ) {
    lastNativeWindowTitle = title;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
      .catch(() => {
        // Updating native chrome is helpful but must never block the visible
        // Web UI in browser preview or during a transient window teardown.
        lastNativeWindowTitle = undefined;
      });
  }

  const description = document.querySelector?.('meta[name="description"]');
  description?.setAttribute(
    "content",
    localized(
      locale,
      "本地优先的 Codex 项目、Usage 与运行状态观察工具",
      "A local-first observer for Codex projects, usage, and runtime status",
    ),
  );
}

function notifySubscribers(locale: AppLocale): void {
  if (
    currentLocale === locale &&
    (typeof document === "undefined" || document.documentElement.lang === locale)
  ) {
    return;
  }
  currentLocale = locale;
  applyDocumentLocale(currentLocale);
  listeners.forEach((listener) => listener());
}

function persistLocale(locale: AppLocale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(APP_LOCALE_STORAGE_KEY, locale);
  } catch {
    // In-memory state still keeps the active WebView usable when storage is
    // unavailable (for example in a restricted browser preview).
  }
}

function ensureCrossWindowSync(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;

  window.addEventListener("storage", (event) => {
    if (event.key === APP_LOCALE_STORAGE_KEY) {
      notifySubscribers(normalizeAppLocale(event.newValue));
    }
  });
  window.addEventListener(APP_LOCALE_EVENT, (event) => {
    const value = (event as CustomEvent<unknown>).detail;
    notifySubscribers(normalizeAppLocale(value));
  });

  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(APP_LOCALE_CHANNEL);
    channel.addEventListener("message", (event) => {
      const locale =
        event.data === "zh-CN" || event.data === "en-US"
          ? event.data
          : event.data?.type === "locale-value"
            ? event.data.locale
            : undefined;
      if (locale === "zh-CN" || locale === "en-US") {
        // Tauri WebViews normally share one localStorage origin. Persisting
        // the broadcast value also covers WebKit configurations that isolate
        // stores between native windows.
        persistLocale(locale);
        notifySubscribers(locale);
      } else if (event.data?.type === "locale-request") {
        channel?.postMessage({ type: "locale-value", locale: currentLocale });
      }
    });
    // A companion WebView can be created after the language changed. Request
    // the current value so the fallback still works even when WebKit isolates
    // localStorage between native windows.
    channel.postMessage({ type: "locale-request" });
  }

  const stored = readStoredLocale();
  currentLocale = stored;
  applyDocumentLocale(stored);
}

export function getAppLocale(): AppLocale {
  return currentLocale;
}

export function setAppLocale(locale: AppLocale): void {
  const normalized = normalizeAppLocale(locale);
  if (typeof window !== "undefined") {
    persistLocale(normalized);
    notifySubscribers(normalized);
    window.dispatchEvent(new CustomEvent(APP_LOCALE_EVENT, { detail: normalized }));
    channel?.postMessage({ type: "locale-value", locale: normalized });
  }
}

export function subscribeToAppLocale(listener: () => void): () => void {
  ensureCrossWindowSync();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Apply a persisted language before React's first paint. */
export function initializeDocumentLocale(): void {
  ensureCrossWindowSync();
}

export function useAppLocale(): AppLocale {
  return useSyncExternalStore(
    subscribeToAppLocale,
    getAppLocale,
    () => DEFAULT_APP_LOCALE,
  );
}

export function localized<T>(locale: AppLocale, chinese: T, english: T): T {
  return locale === "en-US" ? english : chinese;
}

export function intlLocale(locale: AppLocale): string {
  return locale === "en-US" ? "en-US" : "zh-CN";
}
