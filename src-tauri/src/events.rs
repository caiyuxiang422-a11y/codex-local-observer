use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_JSONL_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_STDERR_LINE_BYTES: usize = 8 * 1024;
const MAX_DETAIL_CHARS: usize = 420;

static BEARER_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(authorization:\s*bearer\s+)[^\s,;]+")
        .expect("the bearer-token redaction pattern is valid")
});
static OPENAI_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bsk-[A-Za-z0-9_-]{8,}\b").expect("the OpenAI-key redaction pattern is valid")
});
static API_KEY_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(api[_-]?key[\"']?\s*[:=]\s*[\"']?)[^\"',\s]+"#)
        .expect("the API-key field redaction pattern is valid")
});

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_output_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub schema_version: u8,
    pub event_id: String,
    pub task_id: String,
    pub sequence: u64,
    pub source: String,
    pub received_at: u64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_state: Option<String>,
    pub severity: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning_count: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalCandidate {
    Completed,
    Failed,
}

#[derive(Clone, Debug)]
pub struct AdapterEvent {
    pub public: TaskEvent,
    // Kept inside the adapter so additive upstream fields survive normalization.
    // It is deliberately not sent to the UI or persisted in this first version.
    #[allow(dead_code)]
    pub raw: Option<Value>,
    pub terminal: Option<TerminalCandidate>,
}

pub struct CodexJsonlParser {
    task_id: String,
    sequence: Arc<AtomicU64>,
    first_non_empty_line: bool,
}

impl CodexJsonlParser {
    pub fn new(task_id: String, sequence: Arc<AtomicU64>) -> Self {
        Self {
            task_id,
            sequence,
            first_non_empty_line: true,
        }
    }

    pub fn parse_line(&mut self, input: &[u8]) -> Option<AdapterEvent> {
        let mut line = input;
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            return None;
        }
        if self.first_non_empty_line {
            self.first_non_empty_line = false;
            if line.starts_with(&[0xEF, 0xBB, 0xBF]) {
                line = &line[3..];
            }
        }

        let value: Value = match serde_json::from_slice(line) {
            Ok(value) => value,
            Err(error) => {
                return Some(self.diagnostic(
                    "json.malformed",
                    "收到无法解析的 JSONL 行",
                    Some(format!("{error}；已跳过这一行并继续监听。")),
                ));
            }
        };

        let Some(object) = value.as_object() else {
            return Some(self.diagnostic(
                "json.non_object",
                "收到的 JSONL 不是对象",
                Some("已跳过这一行并继续监听。".to_string()),
            ));
        };
        let Some(raw_type) = object.get("type").and_then(Value::as_str) else {
            return Some(self.diagnostic(
                "json.missing_type",
                "事件缺少字符串 type 字段",
                Some("事件格式可能来自不同版本；已保留兼容性并继续监听。".to_string()),
            ));
        };

        let (kind, state, severity, label, detail, usage, terminal) = match raw_type {
            "thread.started" => (
                "session",
                Some("running"),
                "info",
                "Codex 会话已建立".to_string(),
                object
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .map(|id| format!("会话 ID：{}", truncate_text(id))),
                None,
                None,
            ),
            "turn.started" => (
                "turn",
                Some("running"),
                "info",
                "Codex 开始处理任务".to_string(),
                None,
                None,
                None,
            ),
            "turn.completed" => (
                "turn",
                None,
                "success",
                "Codex 回合已完成".to_string(),
                Some("正在等待进程正常退出，暂不判定最终成功。".to_string()),
                usage_from(object.get("usage")),
                Some(TerminalCandidate::Completed),
            ),
            "turn.failed" => (
                "turn",
                None,
                "error",
                "Codex 报告回合失败".to_string(),
                error_message(object.get("error")),
                None,
                Some(TerminalCandidate::Failed),
            ),
            "error" => (
                "stream",
                None,
                "error",
                "Codex 事件流报告致命错误".to_string(),
                error_message(object.get("message").or_else(|| object.get("error"))),
                None,
                Some(TerminalCandidate::Failed),
            ),
            "item.started" | "item.updated" | "item.completed" => {
                let (label, detail, severity) = item_summary(raw_type, object.get("item"));
                ("item", Some("running"), severity, label, detail, None, None)
            }
            other => (
                "unknown",
                None,
                "warning",
                format!("收到未识别事件：{}", truncate_text(other)),
                Some("当前版本尚未映射它；任务仍会继续，原始字段只在内存适配层保留。".to_string()),
                None,
                None,
            ),
        };

        let sequence = next_sequence(&self.sequence);
        Some(AdapterEvent {
            public: TaskEvent {
                schema_version: 1,
                event_id: format!("{}:{sequence}", self.task_id),
                task_id: self.task_id.clone(),
                sequence,
                source: "codex_exec".to_string(),
                received_at: now_millis(),
                kind: kind.to_string(),
                raw_type: Some(raw_type.to_string()),
                task_state: state.map(str::to_string),
                severity: severity.to_string(),
                label,
                detail: detail.map(|text| redact_and_truncate(&text)),
                usage,
                exit_code: None,
                warning_count: None,
            },
            raw: Some(value),
            terminal,
        })
    }

    pub fn oversized_line(&self, observed_at_least: usize) -> AdapterEvent {
        self.diagnostic(
            "json.oversized",
            "收到过长的 JSONL 行",
            Some(format!(
                "事件至少 {observed_at_least} 字节，超过 {} 字节上限；已丢弃并继续监听。",
                MAX_JSONL_LINE_BYTES
            )),
        )
    }

    fn diagnostic(&self, raw_type: &str, label: &str, detail: Option<String>) -> AdapterEvent {
        let sequence = next_sequence(&self.sequence);
        AdapterEvent {
            public: TaskEvent {
                schema_version: 1,
                event_id: format!("{}:{sequence}", self.task_id),
                task_id: self.task_id.clone(),
                sequence,
                source: "monitor".to_string(),
                received_at: now_millis(),
                kind: "diagnostic".to_string(),
                raw_type: Some(raw_type.to_string()),
                task_state: None,
                severity: "warning".to_string(),
                label: label.to_string(),
                detail,
                usage: None,
                exit_code: None,
                warning_count: None,
            },
            raw: None,
            terminal: None,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn monitor_event(
    task_id: &str,
    sequence: &AtomicU64,
    kind: &str,
    task_state: Option<&str>,
    severity: &str,
    label: &str,
    detail: Option<String>,
    exit_code: Option<i32>,
    warning_count: Option<u64>,
) -> TaskEvent {
    let sequence = next_sequence(sequence);
    TaskEvent {
        schema_version: 1,
        event_id: format!("{task_id}:{sequence}"),
        task_id: task_id.to_string(),
        sequence,
        source: "monitor".to_string(),
        received_at: now_millis(),
        kind: kind.to_string(),
        raw_type: None,
        task_state: task_state.map(str::to_string),
        severity: severity.to_string(),
        label: label.to_string(),
        detail: detail.map(|text| redact_and_truncate(&text)),
        usage: None,
        exit_code,
        warning_count,
    }
}

fn next_sequence(sequence: &AtomicU64) -> u64 {
    sequence.fetch_add(1, Ordering::Relaxed) + 1
}

fn usage_from(value: Option<&Value>) -> Option<UsageSnapshot> {
    let object = value?.as_object()?;
    let usage = UsageSnapshot {
        input_tokens: nonnegative_integer(object.get("input_tokens")),
        cached_input_tokens: nonnegative_integer(object.get("cached_input_tokens")),
        cache_write_input_tokens: nonnegative_integer(object.get("cache_write_input_tokens")),
        output_tokens: nonnegative_integer(object.get("output_tokens")),
        reasoning_output_tokens: nonnegative_integer(object.get("reasoning_output_tokens")),
    };
    if usage == UsageSnapshot::default() {
        None
    } else {
        Some(usage)
    }
}

fn nonnegative_integer(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn item_summary(phase: &str, item: Option<&Value>) -> (String, Option<String>, &'static str) {
    let Some(item) = item.and_then(Value::as_object) else {
        return (
            "收到格式不完整的 item 事件".to_string(),
            Some("缺少 item 对象；已继续监听。".to_string()),
            "warning",
        );
    };
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let completed = phase == "item.completed";
    let nested_status = item.get("status").and_then(Value::as_str);
    let nested_failed = matches!(nested_status, Some("failed" | "declined"));

    match item_type {
        "agent_message" => (
            if completed {
                "Codex 回复已生成"
            } else {
                "Codex 正在组织回复"
            }
            .to_string(),
            item.get("text").and_then(Value::as_str).map(truncate_text),
            "info",
        ),
        "reasoning" => (
            "Codex 正在分析".to_string(),
            Some("推理内容不在观察台中展开。".to_string()),
            "info",
        ),
        "command_execution" => {
            let label = if nested_failed {
                "命令执行未成功"
            } else if completed {
                "命令执行结束"
            } else {
                "正在执行命令"
            };
            let command = item
                .get("command")
                .and_then(Value::as_str)
                .map(truncate_text);
            (
                label.to_string(),
                command,
                if nested_failed { "warning" } else { "info" },
            )
        }
        "file_change" => {
            let count = item
                .get("changes")
                .and_then(Value::as_array)
                .map(|changes| changes.len());
            (
                if nested_failed {
                    "文件变更未成功"
                } else if completed {
                    "文件变更事件结束"
                } else {
                    "收到文件变更事件"
                }
                .to_string(),
                count.map(|value| format!("涉及 {value} 项变更；当前任务运行在只读沙箱。")),
                if nested_failed { "warning" } else { "info" },
            )
        }
        "mcp_tool_call" => (
            if completed {
                "MCP 工具调用结束"
            } else {
                "正在调用 MCP 工具"
            }
            .to_string(),
            tool_detail(item),
            if nested_failed { "warning" } else { "info" },
        ),
        "collab_tool_call" => (
            if completed {
                "协作任务调用结束"
            } else {
                "正在调用协作任务"
            }
            .to_string(),
            tool_detail(item),
            if nested_failed { "warning" } else { "info" },
        ),
        "web_search" => (
            if completed {
                "网络搜索结束"
            } else {
                "正在进行网络搜索"
            }
            .to_string(),
            item.get("query").and_then(Value::as_str).map(truncate_text),
            if nested_failed { "warning" } else { "info" },
        ),
        "todo_list" => (
            "Codex 更新了任务计划".to_string(),
            item.get("items")
                .and_then(Value::as_array)
                .map(|items| format!("当前计划包含 {} 项。", items.len())),
            "info",
        ),
        "error" => (
            "Codex 报告非致命项目错误".to_string(),
            error_message(item.get("message").or_else(|| item.get("error"))),
            "warning",
        ),
        other => (
            format!("收到未识别项目：{}", truncate_text(other)),
            Some(format!("上游阶段：{phase}；已继续监听。")),
            "warning",
        ),
    }
}

fn tool_detail(item: &serde_json::Map<String, Value>) -> Option<String> {
    let server = item.get("server").and_then(Value::as_str);
    let tool = item
        .get("tool")
        .or_else(|| item.get("name"))
        .and_then(Value::as_str);
    match (server, tool) {
        (Some(server), Some(tool)) => Some(format!(
            "{} / {}",
            truncate_text(server),
            truncate_text(tool)
        )),
        (None, Some(tool)) => Some(truncate_text(tool)),
        _ => None,
    }
}

fn error_message(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(message)) => Some(redact_and_truncate(message)),
        Some(Value::Object(object)) => object
            .get("message")
            .and_then(Value::as_str)
            .map(redact_and_truncate),
        _ => None,
    }
}

pub fn redact_and_truncate(input: &str) -> String {
    let redacted = BEARER_TOKEN.replace_all(input, "${1}[REDACTED]");
    let redacted = OPENAI_KEY.replace_all(&redacted, "[REDACTED]");
    let redacted = API_KEY_FIELD.replace_all(&redacted, "${1}[REDACTED]");
    truncate_text(&redacted)
}

fn truncate_text(input: &str) -> String {
    let normalized = input.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let head: String = chars.by_ref().take(MAX_DETAIL_CHARS).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[derive(Debug, Eq, PartialEq)]
pub enum BoundedRead {
    Eof,
    Line {
        oversized: bool,
        observed_at_least: usize,
    },
}

pub fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    output: &mut Vec<u8>,
    limit: usize,
) -> io::Result<BoundedRead> {
    output.clear();
    let mut saw_bytes = false;
    let mut observed = 0usize;
    let mut oversized = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if saw_bytes {
                Ok(BoundedRead::Line {
                    oversized,
                    observed_at_least: observed,
                })
            } else {
                Ok(BoundedRead::Eof)
            };
        }

        saw_bytes = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let chunk_len = newline.unwrap_or(available.len());
        observed = observed.saturating_add(chunk_len);
        if output.len() < limit {
            let remaining = limit - output.len();
            let copy_len = chunk_len.min(remaining);
            output.extend_from_slice(&available[..copy_len]);
        }
        if observed > limit {
            oversized = true;
        }

        let consumed = chunk_len + usize::from(newline.is_some());
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(BoundedRead::Line {
                oversized,
                observed_at_least: observed,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    fn parser() -> CodexJsonlParser {
        CodexJsonlParser::new("task-test".to_string(), Arc::new(AtomicU64::new(0)))
    }

    #[test]
    fn parses_official_lifecycle_and_usage_shape() {
        let mut parser = parser();
        let event = parser
            .parse_line(
                br#"{"type":"turn.completed","usage":{"input_tokens":42,"cached_input_tokens":10,"output_tokens":7}}"#,
            )
            .expect("event");
        assert_eq!(event.terminal, Some(TerminalCandidate::Completed));
        assert_eq!(event.public.raw_type.as_deref(), Some("turn.completed"));
        assert_eq!(event.public.usage.unwrap().input_tokens, Some(42));
    }

    #[test]
    fn malformed_and_unknown_events_do_not_stop_the_parser() {
        let mut parser = parser();
        let malformed = parser.parse_line(b"{not-json").expect("diagnostic");
        let unknown = parser
            .parse_line(br#"{"type":"future.event","new_field":true}"#)
            .expect("unknown event");
        let completed = parser
            .parse_line(br#"{"type":"turn.completed","usage":{}}"#)
            .expect("later valid event");
        assert_eq!(malformed.public.severity, "warning");
        assert_eq!(unknown.public.kind, "unknown");
        assert_eq!(unknown.raw.unwrap()["new_field"], true);
        assert_eq!(completed.terminal, Some(TerminalCandidate::Completed));
    }

    #[test]
    fn accepts_bom_crlf_and_ignores_blank_lines() {
        let mut parser = parser();
        assert!(parser.parse_line(b"  \r").is_none());
        let event = parser
            .parse_line(b"\xEF\xBB\xBF{\"type\":\"thread.started\",\"thread_id\":\"abc\"}\r")
            .expect("event");
        assert_eq!(event.public.task_state.as_deref(), Some("running"));
    }

    #[test]
    fn treats_item_errors_as_warnings_not_terminal_failures() {
        let mut parser = parser();
        let event = parser
            .parse_line(
                br#"{"type":"item.completed","item":{"type":"error","message":"temporary lag"}}"#,
            )
            .expect("event");
        assert_eq!(event.public.severity, "warning");
        assert_eq!(event.terminal, None);
    }

    #[test]
    fn rejects_negative_or_fractional_usage_without_fake_zeroes() {
        let mut parser = parser();
        let event = parser
            .parse_line(
                br#"{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":2.5}}"#,
            )
            .expect("event");
        assert!(event.public.usage.is_none());
    }

    #[test]
    fn redacts_common_secret_shapes() {
        let text =
            redact_and_truncate("Authorization: Bearer abcdef api_key=secret sk-1234567890abcdef");
        assert!(!text.contains("abcdef"));
        assert!(!text.contains("secret"));
        assert!(!text.contains("sk-"));
        assert!(text.contains("[REDACTED]"));
    }

    #[test]
    fn bounded_reader_discards_the_remainder_of_oversized_lines() {
        let input = b"123456789\nnext\n";
        let mut reader = BufReader::new(&input[..]);
        let mut line = Vec::new();
        let result = read_bounded_line(&mut reader, &mut line, 4).expect("read");
        assert_eq!(
            result,
            BoundedRead::Line {
                oversized: true,
                observed_at_least: 9
            }
        );
        assert_eq!(line, b"1234");
        let next = read_bounded_line(&mut reader, &mut line, 4).expect("read next");
        assert_eq!(
            next,
            BoundedRead::Line {
                oversized: false,
                observed_at_least: 4
            }
        );
        assert_eq!(line, b"next");
    }
}
