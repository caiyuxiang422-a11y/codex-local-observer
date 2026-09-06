import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_LOCALE_STORAGE_KEY,
  DEFAULT_APP_LOCALE,
  getAppLocale,
  initializeDocumentLocale,
  intlLocale,
  localized,
  normalizeAppLocale,
  setAppLocale,
} from "./locale";

function installBrowserStubs() {
  const values = new Map<string, string>();
  const attributes = new Map<string, string>();
  const metadata = new Map<string, string>();
  const documentElement = {
    dataset: {} as Record<string, string>,
    get lang() {
      return attributes.get("lang") ?? "";
    },
    set lang(value: string) {
      attributes.set("lang", value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
      if (name === "data-locale") delete this.dataset.locale;
    },
  };
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal("document", {
    documentElement,
    title: "",
    querySelector: (selector: string) =>
      selector === 'meta[name="description"]'
        ? { setAttribute: (_name: string, value: string) => metadata.set("description", value) }
        : null,
  });
  vi.stubGlobal("window", {
    localStorage,
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    location: { search: "" },
  });
  return { documentElement, localStorage, metadata };
}

describe("app locale", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults unknown and missing values to Simplified Chinese", () => {
    installBrowserStubs();
    expect(DEFAULT_APP_LOCALE).toBe("zh-CN");
    expect(normalizeAppLocale(undefined)).toBe("zh-CN");
    expect(normalizeAppLocale("fr-FR")).toBe("zh-CN");
    expect(getAppLocale()).toBe("zh-CN");
  });

  it("persists English and applies the document language", () => {
    const { metadata } = installBrowserStubs();
    setAppLocale("en-US");

    expect(window.localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("en-US");
    expect(getAppLocale()).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(document.documentElement.dataset.locale).toBe("en-US");
    expect(document.title).toBe("Codex Local Observer");
    expect(metadata.get("description")).toContain("local-first observer");
  });

  it("selects copy and Intl locale without translating source evidence", () => {
    expect(localized("zh-CN", "设置", "Settings")).toBe("设置");
    expect(localized("en-US", "设置", "Settings")).toBe("Settings");
    expect(intlLocale("zh-CN")).toBe("zh-CN");
    expect(intlLocale("en-US")).toBe("en-US");
  });

  it("requests and accepts the current locale when a new WebView joins", () => {
    const { localStorage } = installBrowserStubs();
    type MessageListener = (event: { data: unknown }) => void;
    class FakeBroadcastChannel {
      static instance: FakeBroadcastChannel | undefined;
      readonly messages: unknown[] = [];
      listener: MessageListener | undefined;

      constructor(readonly name: string) {
        FakeBroadcastChannel.instance = this;
      }

      addEventListener(_type: string, listener: MessageListener) {
        this.listener = listener;
      }

      postMessage(message: unknown) {
        this.messages.push(message);
      }
    }
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    setAppLocale("zh-CN");

    initializeDocumentLocale();

    expect(FakeBroadcastChannel.instance?.name).toBe("codex-local-observer.locale");
    expect(FakeBroadcastChannel.instance?.messages).toContainEqual({
      type: "locale-request",
    });
    FakeBroadcastChannel.instance?.listener?.({
      data: { type: "locale-value", locale: "en-US" },
    });
    expect(getAppLocale()).toBe("en-US");
    expect(localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("en-US");
    expect(document.title).toBe("Codex Local Observer");
  });
});
