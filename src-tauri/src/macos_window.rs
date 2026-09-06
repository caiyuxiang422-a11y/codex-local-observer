//! macOS-only AppKit bridge for the top-edge widget.
//!
//! Tauri's public window API is enough to create and resize the widget, but it
//! does not expose the AppKit screen safe-area fields or the non-activating
//! panel-style window flags used by a notch shelf.  This module keeps that
//! small platform-specific layer isolated.  Objective-C objects are borrowed
//! only inside `WebviewWindow::with_webview`'s main-thread closure; no raw
//! `NSWindow` pointer is retained between calls.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const WIDGET_LABEL: &str = "widget";
const WIDGET_CROWN_LABEL: &str = "widget-crown";
const FALLBACK_CLOSED_WIDTH: f64 = 220.0;
const FALLBACK_CLOSED_HEIGHT: f64 = 38.0;
const HARDWARE_HIT_MARGIN: f64 = 4.0;
// Keep a small readable information chip on each side of the system-owned
// camera gap. These are logical points, not Retina pixels. The native host is
// widened to contain the chips; the central gap itself remains transparent.
const HARDWARE_SIDE_INFO_WIDTH: f64 = 104.0;
const HARDWARE_SIDE_INFO_GAP: f64 = 8.0;
const HARDWARE_SIDE_VERTICAL_INSET: f64 = 3.0;
// A lower-level medium body is clipped by WindowServer to the complete menu
// bar reservation, which can be taller than the camera safe area. Extend the
// always-front crop through that reservation and one Retina pixel beyond it
// so the two independently composited windows meet without a black seam.
const MEDIUM_SPLIT_OVERLAP: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq)]
struct CompactSideSpan {
    x: f64,
    width: f64,
}

/// Match the native compact glass exactly to the frontend's two side tracks.
///
/// The host owns an outer hit margin and an independent clear gap between
/// each chip and the camera housing. Treating the 8pt clear gap as two 4pt
/// insets makes AppKit extend beyond the web-painted spectrum rim, which
/// exposes a pale native strip beside the camera cut-out.
fn compact_side_spans(
    host_width: f64,
    camera_left: f64,
    camera_right: f64,
) -> Option<(CompactSideSpan, CompactSideSpan)> {
    if !host_width.is_finite()
        || !camera_left.is_finite()
        || !camera_right.is_finite()
        || host_width <= 0.0
        || camera_left < 0.0
        || camera_right <= camera_left
        || camera_right > host_width
    {
        return None;
    }

    let left = CompactSideSpan {
        x: HARDWARE_HIT_MARGIN,
        width: camera_left - HARDWARE_HIT_MARGIN - HARDWARE_SIDE_INFO_GAP,
    };
    let right = CompactSideSpan {
        x: camera_right + HARDWARE_SIDE_INFO_GAP,
        width: host_width - HARDWARE_HIT_MARGIN - camera_right - HARDWARE_SIDE_INFO_GAP,
    };
    (left.width > 2.0 && right.width > 2.0).then_some((left, right))
}

fn compact_side_vertical_geometry(host_height: f64) -> (f64, f64) {
    let height = if host_height.is_finite() {
        (host_height - 2.0 * HARDWARE_SIDE_VERTICAL_INSET).max(1.0)
    } else {
        1.0
    };
    // Keep the native material and the SVG rim as the same true capsule.
    // Capping this at 12pt left short straight segments on a 26pt-high chip,
    // which made the supposedly liquid surface read as a rounded rectangle.
    let radius = height / 2.0;
    (height, radius)
}

/// Presentation state sent by the widget renderer to the native surface.
///
/// This is deliberately separate from the legacy `interactive` boolean:
/// a medium summary may need a larger glass surface while remaining
/// click-through on a real hardware-notch display.  The enum is public so a
/// future native lifecycle caller can use the same wire contract without
/// duplicating string constants.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SurfaceMode {
    Compact,
    Medium,
    Expanded,
    /// Temporary, fully passive host used while the WebView performs its
    /// centre-anchored transform. It removes AppKit glass so a full-size
    /// native material cannot flash before the CSS surface reaches it.
    Transition,
}

/// Native placement policy for the widget host.
///
/// `Notch` preserves the existing top-centred, hardware-aware shelf. A
/// `Floating` host keeps its current centre while resizing, stays inside the
/// current display's visible frame, and behaves like an ordinary draggable
/// utility window. The command accepts this as an optional field so callers
/// compiled against the original bridge continue to use `Notch`.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlacementMode {
    #[default]
    Notch,
    Floating,
}

fn resolve_placement_mode(
    requested: Option<PlacementMode>,
    current_window_is_movable: bool,
) -> PlacementMode {
    requested.unwrap_or({
        if current_window_is_movable {
            PlacementMode::Floating
        } else {
            PlacementMode::Notch
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowLevelPolicy {
    Preserve,
    CameraSafeFront,
    CoverableDesktop,
    Standard,
}

/// Resolve stacking separately from geometry. Compact and expanded camera-safe
/// surfaces need menu-bar level to retain a usable hardware anchor. The passive
/// medium summary can instead sit immediately above Finder's desktop-icon
/// layer: that keeps the summary and its text above wallpaper/files while
/// still allowing ordinary application windows to cover it.
/// `NSNormalWindowLevel` cannot provide both properties because AppKit
/// constrains a normal NSWindow below the menu bar.
fn resolve_window_level_policy(
    placement_mode: PlacementMode,
    surface_mode: Option<SurfaceMode>,
    requested_always_on_top: Option<bool>,
) -> WindowLevelPolicy {
    match placement_mode {
        PlacementMode::Notch => {
            if matches!(surface_mode, Some(SurfaceMode::Medium))
                && matches!(requested_always_on_top, Some(false))
            {
                WindowLevelPolicy::CoverableDesktop
            } else {
                WindowLevelPolicy::CameraSafeFront
            }
        }
        PlacementMode::Floating => match requested_always_on_top {
            Some(true) => WindowLevelPolicy::CameraSafeFront,
            Some(false) => WindowLevelPolicy::Standard,
            None => WindowLevelPolicy::Preserve,
        },
    }
}

/// A single NSWindow cannot mix two WindowServer levels. The coverable medium
/// body therefore gets a second, passive top-band companion for its camera
/// shoulders. Every input is explicit so stale lifecycle calls that omit the
/// presentation cannot accidentally leave an orphan overlay visible.
fn should_show_crown_companion(
    placement_mode: PlacementMode,
    surface_mode: Option<SurfaceMode>,
    requested_always_on_top: Option<bool>,
    has_hardware_notch: bool,
    main_window_visible: bool,
) -> bool {
    matches!(placement_mode, PlacementMode::Notch)
        && matches!(surface_mode, Some(SurfaceMode::Medium))
        && matches!(requested_always_on_top, Some(false))
        && has_hardware_notch
        && main_window_visible
}

/// Place the companion over the top slice of the medium host that WindowServer
/// would otherwise hide behind the menu bar. AppKit coordinates have a
/// bottom-left origin, so the band is anchored to the screen's upper edge.
///
/// The camera safe area and the menu-bar reservation are separate values. On
/// current notched Macs the latter can be several points taller (for example
/// 37pt versus 32pt). A coverable, desktop-level body is occluded through the
/// larger value, so cropping the companion at only `notch_height` exposes a
/// real black band. This crop deliberately extends to the larger measurement,
/// plus a half-point compositing overlap, while the compact hit target remains
/// restricted to the hardware-safe height.
fn crown_companion_frame(geometry: &MacNotchGeometry) -> Option<MacNotchRect> {
    if !geometry.has_hardware_notch {
        return None;
    }
    let main = geometry.window_frame?;
    let screen = geometry.screen_frame;
    let width = main.width.min(screen.width);
    let occluded_top_band = geometry.notch_height.max(geometry.menu_bar_height);
    let height = (occluded_top_band + MEDIUM_SPLIT_OVERLAP)
        .min(main.height)
        .min(screen.height);
    if !main.x.is_finite()
        || !main.width.is_finite()
        || !main.height.is_finite()
        || !width.is_finite()
        || !geometry.notch_height.is_finite()
        || !geometry.menu_bar_height.is_finite()
        || !occluded_top_band.is_finite()
        || !height.is_finite()
        || !screen.x.is_finite()
        || !screen.y.is_finite()
        || !screen.width.is_finite()
        || !screen.height.is_finite()
        || width <= 0.0
        || main.height <= 0.0
        || occluded_top_band <= 0.0
        || height <= 0.0
        || screen.width <= 0.0
        || screen.height <= 0.0
    {
        return None;
    }
    let min_x = screen.x;
    let max_x = screen.x + screen.width - width;
    Some(MacNotchRect {
        x: main.x.clamp(min_x, max_x.max(min_x)),
        y: screen.y + screen.height - height,
        width,
        height,
    })
}

fn should_defer_compact_native_glass(
    surface_mode: SurfaceMode,
    hardware_notch: Option<bool>,
) -> bool {
    matches!(surface_mode, SurfaceMode::Compact) && hardware_notch.is_none()
}

/// The old bridge accepted only `interactive`.  Keep that call shape valid,
/// but let an explicitly supplied surface mode own the interaction policy.
/// `None` means that neither presentation nor interaction should be changed;
/// this is important for calls such as changing always-on-top while an
/// expanded shelf is already open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResolvedSurfacePolicy {
    mode: SurfaceMode,
    requested_interactive: bool,
}

fn resolve_surface_policy(
    surface_mode: Option<SurfaceMode>,
    legacy_interactive: Option<bool>,
) -> Option<ResolvedSurfacePolicy> {
    match surface_mode {
        Some(mode) => Some(ResolvedSurfacePolicy {
            mode,
            // The explicit mode is authoritative.  Medium and compact stay
            // passive even if an older caller accidentally leaves the legacy
            // flag set to true; no-notch fallback interactivity is applied
            // separately after hardware discovery.
            requested_interactive: matches!(mode, SurfaceMode::Expanded),
        }),
        None => legacy_interactive.map(|requested_interactive| ResolvedSurfacePolicy {
            mode: if requested_interactive {
                SurfaceMode::Expanded
            } else {
                SurfaceMode::Compact
            },
            requested_interactive,
        }),
    }
}

fn effective_interactive(requested_interactive: bool, hardware_notch: Option<bool>) -> bool {
    requested_interactive || matches!(hardware_notch, Some(false))
}

fn effective_policy_interactive(
    policy: ResolvedSurfacePolicy,
    hardware_notch: Option<bool>,
) -> bool {
    if matches!(policy.mode, SurfaceMode::Transition) {
        false
    } else {
        effective_interactive(policy.requested_interactive, hardware_notch)
    }
}

fn effective_placement_interactive(
    placement_mode: PlacementMode,
    policy: ResolvedSurfacePolicy,
    hardware_notch: Option<bool>,
) -> bool {
    matches!(placement_mode, PlacementMode::Floating)
        || effective_policy_interactive(policy, hardware_notch)
}

/// Derive the compact host frame from sanitized AppKit measurements.
///
/// `notch_width`/`notch_height` describe the system-owned camera gap. The
/// returned frame includes a narrow information chip on each side of that
/// gap; the centre is still transparent and belongs to macOS. On a notched
/// display its height follows the measured top safe-area height, so the app
/// does not add an extra faux menu-bar/chin strip below the system-owned area.
fn compact_host_size(
    screen_width: f64,
    screen_height: f64,
    safe_top: f64,
    menu_bar_height: f64,
    notch_width: f64,
    has_hardware_notch: bool,
) -> (f64, f64) {
    let screen_width = finite_positive(screen_width, FALLBACK_CLOSED_WIDTH);
    let screen_height = sanitize_non_negative(screen_height);
    let safe_top = sanitize_non_negative(safe_top);
    let menu_bar_height = sanitize_non_negative(menu_bar_height);
    let notch_width = sanitize_non_negative(notch_width);
    let width = if has_hardware_notch && notch_width > 0.0 {
        let side_info_span =
            2.0 * (HARDWARE_SIDE_INFO_WIDTH + HARDWARE_SIDE_INFO_GAP) + 2.0 * HARDWARE_HIT_MARGIN;
        (notch_width + side_info_span).min(screen_width)
    } else {
        // Keep the fallback fully on-screen on narrow external/virtual
        // displays. Normal displays retain the 220pt fallback; when AppKit
        // reports an even narrower screen, fitting the real frame is safer
        // than creating a window that steals pixels from a neighbouring
        // display. The frontend model supplies its 120pt readability floor
        // only when screen dimensions are unknown.
        FALLBACK_CLOSED_WIDTH.min(screen_width)
    };
    let height = if has_hardware_notch && safe_top > 0.0 {
        // Keep a 24pt readability floor for unusually small/rounded safe-area
        // values while using the actual safe-area height on normal MacBook
        // displays. The frontend/native sync may still clamp the final host to
        // an even smaller virtual display when the screen itself is narrower.
        safe_top.max(24.0)
    } else if menu_bar_height > 0.0 {
        // External displays can report a compact 22–24pt menu-bar
        // reservation. Keep the fallback capsule readable instead of letting
        // its CSS inset collapse the hit target below the native minimum.
        menu_bar_height.max(FALLBACK_CLOSED_HEIGHT)
    } else {
        FALLBACK_CLOSED_HEIGHT
    };
    // A virtual/portrait display can be shorter than the usual 24–38pt
    // readability floor.  Returning a frame taller than the owning screen is
    // worse than allowing the frontend's compact-tight ellipsis rules to
    // degrade the presentation, so clamp only when AppKit supplied a valid
    // positive screen height. A zero value means “unknown” and keeps the
    // ordinary fallback contract intact.
    let height = if screen_height > 0.0 {
        height.min(screen_height)
    } else {
        height
    };
    (width, height)
}

fn sanitize_non_negative(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        0.0
    }
}

fn finite_positive(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        fallback
    }
}

/// A rectangle expressed in AppKit logical points.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacNotchRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct MediumContourGeometry {
    left_shoulder: MacNotchRect,
    right_shoulder: MacNotchRect,
    body: MacNotchRect,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct MediumContourSpec {
    width: f64,
    height: f64,
    header: f64,
    gap_left: f64,
    gap_right: f64,
    outer_inset: f64,
    bottom_inset: f64,
    top_inset: f64,
    notch_clearance: f64,
}

/// Build a top-down compound medium contour from the real local camera gap.
/// The centre remains empty only through the measured safe-area band; below
/// that band, the body joins both shoulders into one continuous surface.
fn medium_contour_geometry(spec: MediumContourSpec) -> Option<MediumContourGeometry> {
    let MediumContourSpec {
        width,
        height,
        header,
        gap_left,
        gap_right,
        outer_inset,
        bottom_inset,
        top_inset,
        notch_clearance,
    } = spec;
    if ![width, height, header, gap_left, gap_right]
        .into_iter()
        .all(f64::is_finite)
        || width <= 0.0
        || height <= 0.0
        || header <= top_inset
        || gap_right <= gap_left
    {
        return None;
    }
    let left_edge = outer_inset.max(0.0).min(width);
    let right_edge = (width - outer_inset.max(0.0)).max(left_edge);
    let cleared_left = (gap_left - notch_clearance.max(0.0)).clamp(left_edge, right_edge);
    let cleared_right = (gap_right + notch_clearance.max(0.0)).clamp(left_edge, right_edge);
    let shoulder_bottom = (header + 2.0).min(height - bottom_inset.max(0.0));
    // The body starts exactly below the system-owned camera band. The
    // shoulder rectangles remain useful as pure geometry anchors for the one
    // continuous Bezier outline; their small vertical overlap never becomes
    // a separately filled material layer.
    let body_top = header.max(top_inset);
    let body_bottom = (height - bottom_inset.max(0.0)).max(body_top);
    let left_width = cleared_left - left_edge;
    let right_width = right_edge - cleared_right;
    if left_width <= 2.0 || right_width <= 2.0 || body_bottom - body_top <= 2.0 {
        return None;
    }
    Some(MediumContourGeometry {
        left_shoulder: MacNotchRect {
            x: left_edge,
            y: top_inset,
            width: left_width,
            height: shoulder_bottom - top_inset,
        },
        right_shoulder: MacNotchRect {
            x: cleared_right,
            y: top_inset,
            width: right_width,
            height: shoulder_bottom - top_inset,
        },
        body: MacNotchRect {
            x: left_edge,
            y: body_top,
            width: right_edge - left_edge,
            height: body_bottom - body_top,
        },
    })
}

fn point_is_near_rect(point_x: f64, point_y: f64, rect: MacNotchRect, margin: f64) -> bool {
    point_x >= rect.x - margin
        && point_x <= rect.x + rect.width + margin
        && point_y >= rect.y - margin
        && point_y <= rect.y + rect.height + margin
}

/// A pointer sample expressed in AppKit's global logical-point coordinate
/// space.  Keeping the hit-test result native avoids mixing tao's physical
/// pixel/top-left conversion with `NSScreen`'s logical-point/bottom-left
/// geometry on Retina Macs.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacPointerProximity {
    pub schema_version: u8,
    pub source: String,
    pub supported: bool,
    pub pointer_x: f64,
    pub pointer_y: f64,
    pub margin: f64,
    pub window_visible: bool,
    pub near_window: bool,
    pub screen_name: Option<String>,
    pub window_frame: Option<MacNotchRect>,
    pub limitation: Option<String>,
}

impl Default for MacNotchRect {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        }
    }
}

fn rects_nearly_equal(left: MacNotchRect, right: MacNotchRect, epsilon: f64) -> bool {
    (left.x - right.x).abs() <= epsilon
        && (left.y - right.y).abs() <= epsilon
        && (left.width - right.width).abs() <= epsilon
        && (left.height - right.height).abs() <= epsilon
}

/// Resize around the current centre, then clamp the complete frame to the
/// owning display's visible area. Requested dimensions larger than that area
/// are reduced first; otherwise keeping the whole window visible would be
/// mathematically impossible.
fn floating_target_frame(
    current: MacNotchRect,
    visible: MacNotchRect,
    requested_width: f64,
    requested_height: f64,
) -> Option<MacNotchRect> {
    if ![
        current.x,
        current.y,
        current.width,
        current.height,
        visible.x,
        visible.y,
        visible.width,
        visible.height,
        requested_width,
        requested_height,
    ]
    .into_iter()
    .all(f64::is_finite)
        || current.width < 0.0
        || current.height < 0.0
        || visible.width <= 0.0
        || visible.height <= 0.0
        || requested_width <= 0.0
        || requested_height <= 0.0
    {
        return None;
    }

    let width = requested_width.min(visible.width);
    let height = requested_height.min(visible.height);
    let current_center_x = current.x + current.width / 2.0;
    let current_center_y = current.y + current.height / 2.0;
    let min_x = visible.x;
    let max_x = visible.x + visible.width - width;
    let min_y = visible.y;
    let max_y = visible.y + visible.height - height;

    Some(MacNotchRect {
        x: (current_center_x - width / 2.0).clamp(min_x, max_x),
        y: (current_center_y - height / 2.0).clamp(min_y, max_y),
        width,
        height,
    })
}

/// Return the global-x bounds of the camera safe-area gap when AppKit's two
/// auxiliary top rectangles describe a real central obstruction. Keeping this
/// calculation independent from the native calls makes asymmetric/offset
/// displays testable and avoids assuming that both rectangles start exactly at
/// the screen's left/right edges.
fn inferred_notch_bounds(
    screen: MacNotchRect,
    auxiliary_left: MacNotchRect,
    auxiliary_right: MacNotchRect,
) -> Option<(f64, f64)> {
    const EDGE_TOLERANCE: f64 = 2.0;
    let screen_left = screen.x;
    let screen_right = screen.x + screen.width;
    let screen_top = screen.y + screen.height;
    let gap_left = auxiliary_left.x + auxiliary_left.width;
    let gap_right = auxiliary_right.x;
    let area_is_valid = |area: MacNotchRect| {
        area.width > 1.0
            && area.height > 1.0
            && area.x >= screen_left - EDGE_TOLERANCE
            && area.x + area.width <= screen_right + EDGE_TOLERANCE
            && area.y >= screen.y - EDGE_TOLERANCE
            && area.y + area.height <= screen_top + EDGE_TOLERANCE
            // Auxiliary areas are top-edge reservations. Requiring their
            // upper edge to align with the screen prevents a malformed
            // external-display inset from being mistaken for a camera gap.
            && (area.y + area.height - screen_top).abs() <= EDGE_TOLERANCE
    };
    if !screen.width.is_finite()
        || screen.width <= 0.0
        || !screen.height.is_finite()
        || screen.height <= 0.0
        || !gap_left.is_finite()
        || !gap_right.is_finite()
        || !area_is_valid(auxiliary_left)
        || !area_is_valid(auxiliary_right)
        || (auxiliary_left.y - auxiliary_right.y).abs() > EDGE_TOLERANCE
        || (auxiliary_left.height - auxiliary_right.height).abs() > EDGE_TOLERANCE
        || gap_left < screen_left
        || gap_right > screen_right
        || gap_left >= gap_right
        || gap_right - gap_left <= 1.0
        || gap_right - gap_left >= screen.width - 1.0
    {
        return None;
    }
    Some((gap_left, gap_right))
}

/// Screen and host-window geometry consumed by the widget renderer.
///
/// Dimensions are deliberately AppKit logical points rather than Retina
/// backing pixels.  `supported` distinguishes a real AppKit response from
/// the non-macOS/temporarily-unavailable fallback; zero-valued safe-area and
/// notch dimensions are therefore meaningful on an external display.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacNotchGeometry {
    pub schema_version: u8,
    pub source: String,
    pub updated_at: u64,
    pub supported: bool,
    pub host_kind: String,
    pub screen_name: Option<String>,
    pub has_hardware_notch: bool,
    pub notch_width: f64,
    /// AppKit's top safe-area height used for the closed surface; this is a
    /// layout measurement, not a writable or independently controlled piece
    /// of hardware.
    pub notch_height: f64,
    /// Height reserved by the system for the menu bar on this display.
    /// On a notched Mac this is the menu-bar reservation reported by AppKit.
    /// It is diagnostic only; the collapsed host uses `safe_area_top` for its
    /// visible/hit height so it does not invent a chin below the hardware gap.
    pub menu_bar_height: f64,
    /// Recommended logical width for the compact host, including the two
    /// information chips beside a real hardware gap.
    pub closed_width: f64,
    pub closed_height: f64,
    pub safe_area_top: f64,
    pub safe_area_left: f64,
    pub safe_area_bottom: f64,
    pub safe_area_right: f64,
    pub auxiliary_top_left_width: f64,
    pub auxiliary_top_right_width: f64,
    pub backing_scale_factor: f64,
    pub screen_frame: MacNotchRect,
    pub visible_frame: MacNotchRect,
    pub window_frame: Option<MacNotchRect>,
    /// Native diagnostic values are optional because the non-macOS fallback
    /// has no NSWindow to inspect.
    pub window_level: Option<i64>,
    pub window_style_mask: Option<u64>,
    pub window_collection_behavior: Option<u64>,
    pub window_is_opaque: Option<bool>,
    pub window_has_shadow: Option<bool>,
    pub window_is_movable: Option<bool>,
    pub window_is_key: Option<bool>,
    /// Alpha of the WKWebView content view. Compact hardware mode keeps this
    /// visible for the two side information chips; the central camera spacer
    /// is transparent in the renderer. A zero value is reserved for a
    /// pending/failed surface or an explicitly hidden view.
    pub webview_alpha_value: Option<f64>,
    /// Hardware-notch compact mode is deliberately click-through so the app
    /// never steals clicks from the menu bar. The side information remains
    /// visible, while the frontend uses the global pointer proximity fallback
    /// to open the shelf and then enables interaction. A display without a
    /// hardware notch keeps its fallback capsule interactive.
    pub window_ignores_mouse_events: Option<bool>,
    pub window_accepts_mouse_moved_events: Option<bool>,
    /// `Some(true)` is returned only after AppKit has installed and ordered
    /// the independent top crop, the current companion WebView session has
    /// reported painted content, and the lower body-only material succeeded.
    /// The renderer uses this ownership acknowledgement before removing its
    /// duplicate crown.
    pub crown_companion_visible: Option<bool>,
    pub limitation: Option<String>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn fallback_geometry(source: &str, supported: bool, limitation: Option<&str>) -> MacNotchGeometry {
    MacNotchGeometry {
        schema_version: 1,
        source: source.to_string(),
        updated_at: now_millis(),
        supported,
        host_kind: "NSWindow".to_string(),
        screen_name: None,
        has_hardware_notch: false,
        notch_width: 0.0,
        notch_height: 0.0,
        menu_bar_height: 0.0,
        closed_width: FALLBACK_CLOSED_WIDTH,
        closed_height: FALLBACK_CLOSED_HEIGHT,
        safe_area_top: 0.0,
        safe_area_left: 0.0,
        safe_area_bottom: 0.0,
        safe_area_right: 0.0,
        auxiliary_top_left_width: 0.0,
        auxiliary_top_right_width: 0.0,
        backing_scale_factor: 1.0,
        screen_frame: MacNotchRect::default(),
        visible_frame: MacNotchRect::default(),
        window_frame: None,
        window_level: None,
        window_style_mask: None,
        window_collection_behavior: None,
        window_is_opaque: None,
        window_has_shadow: None,
        window_is_movable: None,
        window_is_key: None,
        webview_alpha_value: None,
        window_ignores_mouse_events: None,
        window_accepts_mouse_moved_events: None,
        crown_companion_visible: None,
        limitation: limitation.map(str::to_string),
    }
}

fn fallback_pointer_proximity(source: &str, limitation: Option<&str>) -> MacPointerProximity {
    MacPointerProximity {
        schema_version: 1,
        source: source.to_string(),
        supported: false,
        pointer_x: 0.0,
        pointer_y: 0.0,
        margin: 0.0,
        window_visible: false,
        near_window: false,
        screen_name: None,
        window_frame: None,
        limitation: limitation.map(str::to_string),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSBezierPath, NSColor, NSCompositingOperation, NSEvent, NSImage,
        NSMainMenuWindowLevel, NSNormalWindowLevel, NSRectFillUsingOperation, NSScreen, NSView,
        NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSWindow,
        NSWindowCollectionBehavior, NSWindowOrderingMode, NSWindowStyleMask,
    };
    use objc2_core_graphics::{CGWindowLevelForKey, CGWindowLevelKey};
    use objc2_foundation::{NSEdgeInsets, NSInteger, NSPoint, NSRect, NSSize};
    use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
    use std::time::Duration;
    use window_vibrancy::NSVisualEffectViewTagged;

    const SOURCE: &str = "appkit";

    // NSView::tag is process-local and only used to find the effect view below
    // the WKWebView on subsequent geometry/visibility updates.  Keep this
    // separate from window-vibrancy's own tag in case another Tauri plugin is
    // active in the same process.
    const NATIVE_GLASS_VIEW_TAG: NSInteger = 91_376_255;
    const NATIVE_GLASS_LEFT_TAG: NSInteger = 91_376_256;
    const NATIVE_GLASS_RIGHT_TAG: NSInteger = 91_376_257;
    const FALLBACK_GLASS_TOP_INSET: f64 = 6.0;
    const FALLBACK_GLASS_RADIUS: f64 = 999.0;
    const MEDIUM_GLASS_RADIUS: f64 = 28.0;
    const MEDIUM_GLASS_HORIZONTAL_INSET: f64 = 8.0;
    const MEDIUM_GLASS_BOTTOM_INSET: f64 = 8.0;
    const MEDIUM_GLASS_NOTCH_CLEARANCE: f64 = 5.0;
    const MEDIUM_GLASS_TOP_INSET: f64 = 3.0;
    const MEDIUM_GLASS_SHOULDER_RADIUS: f64 = 16.0;
    const MEDIUM_GLASS_NOTCH_RADIUS: f64 = 11.0;
    const EXPANDED_GLASS_RADIUS: f64 = 30.0;

    fn apply_window_level(
        window: &NSWindow,
        placement_mode: PlacementMode,
        surface_mode: Option<SurfaceMode>,
        requested_always_on_top: Option<bool>,
    ) {
        let level = match resolve_window_level_policy(
            placement_mode,
            surface_mode,
            requested_always_on_top,
        ) {
            WindowLevelPolicy::Preserve => return,
            WindowLevelPolicy::CameraSafeFront => NSMainMenuWindowLevel + 3,
            WindowLevelPolicy::CoverableDesktop => {
                CGWindowLevelForKey(CGWindowLevelKey::DesktopIconWindowLevelKey) as NSInteger + 1
            }
            WindowLevelPolicy::Standard => NSNormalWindowLevel,
        };
        window.setLevel(level);
    }

    /// Configure the existing Tauri host as a notch-like utility surface.
    ///
    /// `interactive` is intentionally separate from visibility. A compact
    /// hardware-notch host keeps two small information chips visible beside
    /// the system-owned gap, remains click-through, and opens from the
    /// low-frequency pointer-proximity fallback. Expanded controls turn
    /// interaction back on. Displays without a hardware cut-out keep the
    /// fallback capsule interactive so it remains usable even when
    /// pointer-position permission is unavailable.
    /// The native object is borrowed only for this closure.
    // These fields deliberately mirror independent AppKit policies (level,
    // hit testing, material mode, placement and split-surface ownership).
    // Keeping them explicit at the two call sites makes an accidental implicit
    // ownership transfer easier to audit than a loosely populated options bag.
    #[allow(clippy::too_many_arguments)]
    fn configure_host_window(
        window: &NSWindow,
        raw_webview: *mut std::ffi::c_void,
        order_front: bool,
        always_on_top: Option<bool>,
        interactive: Option<bool>,
        surface_mode: Option<SurfaceMode>,
        placement_mode: PlacementMode,
        medium_header_owned_by_companion: bool,
    ) -> bool {
        // Tauri supplies an NSWindow, not an NSPanel. AppKit rejects the
        // `UtilityWindow` and `NonactivatingPanel` bits on this host and would
        // log the rejection again on every geometry refresh because the bits
        // never stick. Keep the supported borderless style only; Tauri's
        // focusable flag plus `setIgnoresMouseEvents` below own activation and
        // hit testing, while the renderer/native vibrancy views own material.
        let floating = matches!(placement_mode, PlacementMode::Floating);
        let style = NSWindowStyleMask::Borderless;
        // AppKit can rebuild portions of the content hierarchy when a style
        // mask changes.  Avoid doing that on every five-second geometry poll.
        if window.styleMask() != style {
            window.setStyleMask(style);
        }
        window.setOpaque(false);
        let clear_color = NSColor::clearColor();
        window.setBackgroundColor(Some(&clear_color));
        window.setHasShadow(false);
        window.setMovable(floating);
        window.setMovableByWindowBackground(floating);
        window.setHidesOnDeactivate(false);
        let collection_behavior = if floating {
            NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::IgnoresCycle
        } else {
            NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::IgnoresCycle
        };
        window.setCollectionBehavior(collection_behavior);
        let resolved_policy = if surface_mode.is_none() {
            // Backend hide/show predates the frontend presentation field. On
            // the one explicit order-front pass, infer only enough from the
            // retained frame height to restore a complete native material.
            // This must take precedence over the legacy `interactive=false`
            // fallback, which would otherwise repaint a 560×224 summary with
            // compact material for its first visible frame. Non-ordering
            // lifecycle syncs leave the inferred material untouched until the
            // renderer follows with an exact, generation-scoped request.
            order_front.then(|| {
                let height = window.frame().size.height;
                let mode = if height <= 64.0 {
                    SurfaceMode::Compact
                } else if height <= 300.0 {
                    SurfaceMode::Medium
                } else {
                    SurfaceMode::Expanded
                };
                ResolvedSurfacePolicy {
                    mode,
                    requested_interactive: false,
                }
            })
        } else {
            resolve_surface_policy(surface_mode, interactive)
        };
        let mut material_ready = true;
        if let Some(policy) = resolved_policy {
            // A non-notched display needs a real hit target for its visible
            // fallback capsule. On a hardware-notched display the compact
            // and medium surfaces remain passive, but the host must not
            // intercept menu-bar clicks. If screen discovery is temporarily
            // unavailable, prefer the safe click-through behavior.
            let hardware_notch = if floating {
                // A detached window is application-owned on every display. It
                // must never inherit the top-edge camera cut-out material.
                Some(false)
            } else {
                MainThreadMarker::new().and_then(|mtm| screen_has_hardware_notch(window, mtm))
            };
            // When AppKit has not identified the display yet, prefer the
            // safe side: an unknown host must not intercept clicks intended
            // for the menu bar. The frontend keeps polling and can request
            // the expanded interaction explicitly on the next sync.
            let effective_interactive =
                effective_placement_interactive(placement_mode, policy, hardware_notch);
            window.setIgnoresMouseEvents(!effective_interactive);
            window.setAcceptsMouseMovedEvents(effective_interactive);

            // Keep the actual AppKit backdrop in sync with the presentation
            // state. Medium hardware-notch mode deliberately removes the
            // full-block native view (the CSS summary keeps its top centre
            // transparent); fallback and expanded modes can use the full
            // material. Interaction remains independently click-through for
            // compact/medium hardware states.
            material_ready = sync_native_glass_surface(
                window,
                raw_webview,
                policy.mode,
                hardware_notch,
                placement_mode,
                medium_header_owned_by_companion,
            );

            // Keep the WebView visible in compact hardware mode: its two side
            // chips carry the basic status. The central camera spacer remains
            // transparent in CSS, and the native window is still click-through
            // until the proximity poll requests the expanded controls. The
            // explicit alpha write also prevents a stale zero alpha after a
            // previous hidden/expanded transition.
            set_webview_surface_visible(raw_webview, true);
        }
        // Resolve stacking without changing the camera-safe geometry. Compact
        // and expanded surfaces stay above the menu bar; a passive medium
        // summary may instead use DesktopIcon + 1 so it stays above wallpaper
        // and Finder files while ordinary app windows can still cover it.
        apply_window_level(window, placement_mode, surface_mode, always_on_top);
        if order_front {
            // This orders the shelf without retaining or globally storing the
            // Objective-C object. The style hint plus orderFrontRegardless
            // avoids an additional explicit key request; exact NSPanel
            // canBecomeKey semantics require a separate native host.
            window.orderFrontRegardless();
        }
        material_ready
    }

    fn finite_non_negative(value: f64) -> f64 {
        if value.is_finite() && value >= 0.0 {
            value
        } else {
            0.0
        }
    }

    fn finite_coordinate(value: f64) -> f64 {
        if value.is_finite() {
            value
        } else {
            0.0
        }
    }

    fn rect(rect: NSRect) -> MacNotchRect {
        MacNotchRect {
            x: finite_coordinate(rect.origin.x),
            y: finite_coordinate(rect.origin.y),
            width: finite_non_negative(rect.size.width),
            height: finite_non_negative(rect.size.height),
        }
    }

    fn edge_insets(insets: NSEdgeInsets) -> (f64, f64, f64, f64) {
        (
            finite_non_negative(insets.top),
            finite_non_negative(insets.left),
            finite_non_negative(insets.bottom),
            finite_non_negative(insets.right),
        )
    }

    fn point_is_inside_rect(point: NSPoint, rect: NSRect) -> bool {
        point.x >= rect.origin.x
            && point.x <= rect.origin.x + rect.size.width
            && point.y >= rect.origin.y
            && point.y <= rect.origin.y + rect.size.height
    }

    fn measured_screen_has_hardware_notch(screen: &NSScreen) -> bool {
        if !objc2::available!(macos = 12.0, ..) {
            return false;
        }
        let (safe_top, _, _, _) = edge_insets(screen.safeAreaInsets());
        let screen_frame = rect(screen.frame());
        let auxiliary_left = rect(screen.auxiliaryTopLeftArea());
        let auxiliary_right = rect(screen.auxiliaryTopRightArea());
        safe_top > 0.0
            && inferred_notch_bounds(screen_frame, auxiliary_left, auxiliary_right).is_some()
    }

    /// Return whether the window's current display exposes a real central
    /// camera gap through AppKit's public safe-area/auxiliary-area APIs.
    /// `None` means the display is not discoverable yet; callers should use a
    /// conservative, usable fallback in that case.
    fn screen_has_hardware_notch(window: &NSWindow, mtm: MainThreadMarker) -> Option<bool> {
        let screen = screen_for_window(window, mtm)?;
        Some(measured_screen_has_hardware_notch(&screen))
    }

    /// Hide/show the WKWebView's pixels using the public NSView API. This is
    /// deliberately an alpha change, not `setHidden`: keeping the view alive
    /// lets the frontend's low-frequency cursor polling continue while a
    /// transition or a deferred native surface update is in flight.
    fn set_webview_surface_visible(raw_webview: *mut std::ffi::c_void, visible: bool) {
        if raw_webview.is_null() {
            return;
        }
        let webview: &NSView = unsafe { &*raw_webview.cast() };
        webview.setAlphaValue(if visible { 1.0 } else { 0.0 });
    }

    /// Configure one tagged AppKit vibrancy view below the WKWebView.
    fn ensure_glass_view(
        webview: &NSView,
        frame: NSRect,
        tag: NSInteger,
        radius: f64,
        mask_image: Option<&NSImage>,
    ) -> Option<Retained<NSVisualEffectViewTagged>> {
        let effect: Retained<NSVisualEffectViewTagged> = if let Some(existing) =
            webview.viewWithTag(tag)
        {
            // `viewWithTag` can only return one of the tagged views created by
            // this module. The cast is scoped to this main-thread callback.
            unsafe { Retained::cast_unchecked(existing) }
        } else {
            let mtm = MainThreadMarker::new()?;
            let effect =
                unsafe { NSVisualEffectViewTagged::initWithFrame(mtm.alloc(), frame, tag) };
            unsafe {
                // Popover is a semantic light material. BehindWindow lets
                // AppKit sample the desktop behind this transparent utility
                // window; Active avoids an inactive-window muddy tint.
                effect.setMaterial(NSVisualEffectMaterial::Popover);
                effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
                effect.setState(NSVisualEffectState::Active);
                effect.setCornerRadius(radius);
                effect.setAutoresizingMask(
                    NSAutoresizingMaskOptions::ViewWidthSizable
                        | NSAutoresizingMaskOptions::ViewHeightSizable,
                );
            }
            webview.addSubview_positioned_relativeTo(&effect, NSWindowOrderingMode::Below, None);
            effect
        };

        // A cached view can still carry the previous presentation's mask.
        // Configure it while hidden so an instant switch never exposes one
        // compositor frame of the old full rectangle or old medium contour.
        effect.setAlphaValue(0.0);
        effect.setHidden(true);
        effect.setFrame(frame);
        unsafe {
            effect.setCornerRadius(radius);
        }
        effect.setMaskImage(mask_image);
        effect.setHidden(false);
        effect.setAlphaValue(1.0);
        Some(effect)
    }

    fn hide_glass_view(webview: &NSView, tag: NSInteger) {
        if let Some(existing) = webview.viewWithTag(tag) {
            // Retain the effect view so an instant presentation reversal does
            // not allocate and compile a new BehindWindow material on the
            // AppKit main thread. The next ensure call updates its frame,
            // radius and mask before it is presented again.
            existing.setAlphaValue(0.0);
            existing.setHidden(true);
        }
    }

    fn local_hardware_gap(
        window: &NSWindow,
        webview: &NSView,
        screen: &NSScreen,
    ) -> Option<(f64, f64)> {
        if !objc2::available!(macos = 12.0, ..) {
            return None;
        }
        let bounds = webview.bounds();
        let host_width = bounds.size.width;
        let screen_frame = rect(screen.frame());
        let auxiliary_left = rect(screen.auxiliaryTopLeftArea());
        let auxiliary_right = rect(screen.auxiliaryTopRightArea());
        let (gap_left, gap_right) =
            inferred_notch_bounds(screen_frame, auxiliary_left, auxiliary_right)?;
        let window_frame = window.frame();
        let left = (gap_left - window_frame.origin.x - bounds.origin.x).clamp(0.0, host_width);
        let right = (gap_right - window_frame.origin.x - bounds.origin.x).clamp(0.0, host_width);
        (right - left > 2.0).then_some((left, right))
    }

    /// Trace one continuous top-down outline around the real camera gap.
    ///
    /// The path owns the complete visible material boundary: rounded outer
    /// shoulders, the transparent top notch recess, and the rounded lower
    /// body. Using one outline avoids the alpha seams produced by overlapping
    /// independent rounded rectangles.
    fn medium_contour_path(contour: MediumContourGeometry) -> Retained<NSBezierPath> {
        const CIRCLE_KAPPA: f64 = 0.552_284_749_830_793_6;

        let left = contour.body.x;
        let right = contour.body.x + contour.body.width;
        let top = contour.left_shoulder.y.min(contour.right_shoulder.y);
        let bottom = contour.body.y + contour.body.height;
        let header = contour.body.y;
        let gap_left = contour.left_shoulder.x + contour.left_shoulder.width;
        let gap_right = contour.right_shoulder.x;
        let left_shoulder_width = (gap_left - left).max(0.0);
        let right_shoulder_width = (right - gap_right).max(0.0);
        let top_band_height = (header - top).max(0.0);
        let top_radius = MEDIUM_GLASS_SHOULDER_RADIUS
            .min(left_shoulder_width / 2.0)
            .min(right_shoulder_width / 2.0)
            .min(top_band_height);
        let notch_radius = MEDIUM_GLASS_NOTCH_RADIUS
            .min(left_shoulder_width / 2.0)
            .min(right_shoulder_width / 2.0)
            .min((gap_right - gap_left).max(0.0) / 2.0)
            .min(top_band_height / 2.0);
        let bottom_radius = MEDIUM_GLASS_RADIUS
            .min((right - left).max(0.0) / 2.0)
            .min((bottom - header).max(0.0));
        let point = |x: f64, y: f64| NSPoint { x, y };
        let path = NSBezierPath::bezierPath();

        path.moveToPoint(point(left + top_radius, top));
        path.lineToPoint(point(gap_left - notch_radius, top));
        path.curveToPoint_controlPoint1_controlPoint2(
            point(gap_left, top + notch_radius),
            point(gap_left - notch_radius + CIRCLE_KAPPA * notch_radius, top),
            point(gap_left, top + notch_radius - CIRCLE_KAPPA * notch_radius),
        );
        path.lineToPoint(point(gap_left, header - notch_radius));
        path.curveToPoint_controlPoint1_controlPoint2(
            point(gap_left + notch_radius, header),
            point(
                gap_left,
                header - notch_radius + CIRCLE_KAPPA * notch_radius,
            ),
            point(
                gap_left + notch_radius - CIRCLE_KAPPA * notch_radius,
                header,
            ),
        );
        path.lineToPoint(point(gap_right - notch_radius, header));
        path.curveToPoint_controlPoint1_controlPoint2(
            point(gap_right, header - notch_radius),
            point(
                gap_right - notch_radius + CIRCLE_KAPPA * notch_radius,
                header,
            ),
            point(
                gap_right,
                header - notch_radius + CIRCLE_KAPPA * notch_radius,
            ),
        );
        path.lineToPoint(point(gap_right, top + notch_radius));
        path.curveToPoint_controlPoint1_controlPoint2(
            point(gap_right + notch_radius, top),
            point(gap_right, top + notch_radius - CIRCLE_KAPPA * notch_radius),
            point(gap_right + notch_radius - CIRCLE_KAPPA * notch_radius, top),
        );
        path.lineToPoint(point(right - top_radius, top));
        path.curveToPoint_controlPoint1_controlPoint2(
            point(right, top + top_radius),
            point(right - top_radius + CIRCLE_KAPPA * top_radius, top),
            point(right, top + top_radius - CIRCLE_KAPPA * top_radius),
        );
        path.lineToPoint(point(right, bottom - bottom_radius));
        path.curveToPoint_controlPoint1_controlPoint2(
            point(right - bottom_radius, bottom),
            point(right, bottom - bottom_radius + CIRCLE_KAPPA * bottom_radius),
            point(right - bottom_radius + CIRCLE_KAPPA * bottom_radius, bottom),
        );
        path.lineToPoint(point(left + bottom_radius, bottom));
        path.curveToPoint_controlPoint1_controlPoint2(
            point(left, bottom - bottom_radius),
            point(left + bottom_radius - CIRCLE_KAPPA * bottom_radius, bottom),
            point(left, bottom - bottom_radius + CIRCLE_KAPPA * bottom_radius),
        );
        path.lineToPoint(point(left, top + top_radius));
        path.curveToPoint_controlPoint1_controlPoint2(
            point(left + top_radius, top),
            point(left, top + top_radius - CIRCLE_KAPPA * top_radius),
            point(left + top_radius - CIRCLE_KAPPA * top_radius, top),
        );
        path.closePath();
        path
    }

    /// Build one resolution-independent alpha mask for the real medium
    /// contour. The material is continuous below the camera band and has two
    /// shoulders beside it; no pixel is drawn into the measured top gap.
    fn medium_contour_mask(
        window: &NSWindow,
        webview: &NSView,
        screen: &NSScreen,
        body_only: bool,
    ) -> Option<Retained<NSImage>> {
        let bounds = webview.bounds();
        let width = bounds.size.width;
        let height = bounds.size.height;
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return None;
        }
        let (gap_left, gap_right) = local_hardware_gap(window, webview, screen)?;
        let (safe_top, _, _, _) = edge_insets(screen.safeAreaInsets());
        // Medium geometry follows the real camera-safe height exactly. The
        // compact host may keep a 24pt readability floor, but applying that
        // floor here would make a short companion crop and the main contour
        // disagree, leaving a transparent seam between them.
        let header = safe_top
            .max(MEDIUM_GLASS_TOP_INSET + 1.0)
            .clamp(MEDIUM_GLASS_TOP_INSET + 1.0, (height - 1.0).max(0.0));
        let contour = medium_contour_geometry(MediumContourSpec {
            width,
            height,
            header,
            gap_left,
            gap_right,
            outer_inset: MEDIUM_GLASS_HORIZONTAL_INSET,
            bottom_inset: MEDIUM_GLASS_BOTTOM_INSET,
            top_inset: MEDIUM_GLASS_TOP_INSET,
            notch_clearance: MEDIUM_GLASS_NOTCH_CLEARANCE,
        })?;
        let drawing_handler = RcBlock::new(move |_destination: NSRect| -> Bool {
            NSColor::whiteColor().setFill();
            medium_contour_path(contour).fill();
            if body_only {
                // The top slice is supplied by the independent companion
                // window when the summary body is coverable. Clear it from
                // the lower-level material so it is not composited twice.
                let clear_height = (header - MEDIUM_SPLIT_OVERLAP).clamp(0.0, height);
                NSRectFillUsingOperation(
                    NSRect {
                        origin: NSPoint { x: 0.0, y: 0.0 },
                        size: NSSize {
                            width,
                            height: clear_height,
                        },
                    },
                    NSCompositingOperation::Clear,
                );
            }
            Bool::YES
        });
        Some(NSImage::imageWithSize_flipped_drawingHandler(
            NSSize { width, height },
            true,
            &drawing_handler,
        ))
    }

    /// Build the exact top crop of the existing medium contour for the
    /// always-visible companion. The image canvas is only camera-band high,
    /// while the path retains the full medium height; AppKit clips the lower
    /// body without inventing rounded bottoms for two separate capsules.
    fn medium_crown_mask(
        window: &NSWindow,
        webview: &NSView,
        screen: &NSScreen,
        full_height: f64,
    ) -> Option<Retained<NSImage>> {
        let bounds = webview.bounds();
        let width = bounds.size.width;
        let band_height = bounds.size.height;
        if !width.is_finite()
            || !band_height.is_finite()
            || !full_height.is_finite()
            || width <= 0.0
            || band_height <= 0.0
            || full_height <= band_height
        {
            return None;
        }
        let (gap_left, gap_right) = local_hardware_gap(window, webview, screen)?;
        let (safe_top, _, _, _) = edge_insets(screen.safeAreaInsets());
        let header = safe_top
            .max(MEDIUM_GLASS_TOP_INSET + 1.0)
            .clamp(MEDIUM_GLASS_TOP_INSET + 1.0, (full_height - 1.0).max(0.0));
        let contour = medium_contour_geometry(MediumContourSpec {
            width,
            height: full_height,
            header,
            gap_left,
            gap_right,
            outer_inset: MEDIUM_GLASS_HORIZONTAL_INSET,
            bottom_inset: MEDIUM_GLASS_BOTTOM_INSET,
            top_inset: MEDIUM_GLASS_TOP_INSET,
            notch_clearance: MEDIUM_GLASS_NOTCH_CLEARANCE,
        })?;
        let drawing_handler = RcBlock::new(move |_destination: NSRect| -> Bool {
            NSColor::whiteColor().setFill();
            medium_contour_path(contour).fill();
            Bool::YES
        });
        Some(NSImage::imageWithSize_flipped_drawingHandler(
            NSSize {
                width,
                height: band_height,
            },
            true,
            &drawing_handler,
        ))
    }

    fn sync_native_crown_glass_surface(
        window: &NSWindow,
        raw_webview: *mut std::ffi::c_void,
        full_height: f64,
    ) -> bool {
        if raw_webview.is_null() {
            return false;
        }
        let webview: &NSView = unsafe { &*raw_webview.cast() };
        hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
        hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
        let Some(mtm) = MainThreadMarker::new() else {
            hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
            return false;
        };
        let Some(screen) = screen_for_window(window, mtm) else {
            hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
            return false;
        };
        let Some(mask) = medium_crown_mask(window, webview, &screen, full_height) else {
            hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
            return false;
        };
        ensure_glass_view(
            webview,
            webview.bounds(),
            NATIVE_GLASS_VIEW_TAG,
            0.0,
            Some(&mask),
        )
        .is_some()
    }

    /// Configure the companion directly as one passive camera-band crop.
    /// Routing it through compact mode would briefly allocate two unrelated
    /// pill materials before replacing them with the medium contour mask.
    fn configure_crown_host(
        window: &NSWindow,
        raw_webview: *mut std::ffi::c_void,
        full_height: f64,
    ) -> bool {
        let style = NSWindowStyleMask::Borderless;
        if window.styleMask() != style {
            window.setStyleMask(style);
        }
        window.setOpaque(false);
        let clear_color = NSColor::clearColor();
        window.setBackgroundColor(Some(&clear_color));
        window.setHasShadow(false);
        window.setMovable(false);
        window.setMovableByWindowBackground(false);
        window.setHidesOnDeactivate(false);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        window.setIgnoresMouseEvents(true);
        window.setAcceptsMouseMovedEvents(false);
        apply_window_level(
            window,
            PlacementMode::Notch,
            Some(SurfaceMode::Compact),
            Some(true),
        );

        let ready = sync_native_crown_glass_surface(window, raw_webview, full_height);
        set_webview_surface_visible(raw_webview, ready);
        if !ready {
            return false;
        }
        window.orderFrontRegardless();
        let frame = window.frame();
        window.isVisible()
            && frame.size.width.is_finite()
            && frame.size.width > 0.0
            && frame.size.height.is_finite()
            && frame.size.height > 0.0
            && webview_alpha_value(raw_webview).unwrap_or(0.0) >= 0.99
    }

    /// Return local WKWebView frames for the two side chips around a real
    /// camera gap. AppKit screen coordinates may have a non-zero origin or
    /// asymmetric auxiliary areas, so derive the local frames instead of
    /// assuming the gap is exactly centred in the host.
    fn compact_side_frames(
        window: &NSWindow,
        webview: &NSView,
        screen: &NSScreen,
    ) -> Option<(NSRect, NSRect)> {
        if !objc2::available!(macos = 12.0, ..) {
            return None;
        }
        let bounds = webview.bounds();
        let host_width = bounds.size.width;
        let host_height = bounds.size.height;
        if !host_width.is_finite()
            || !host_height.is_finite()
            || host_width <= 0.0
            || host_height <= 0.0
        {
            return None;
        }
        let (left, right) = local_hardware_gap(window, webview, screen)?;

        // Match the CSS grid's 4pt outer margin and its complete 8pt clear
        // space on both sides of the system-owned camera area. The previous
        // formula consumed only half that inner gap, so native glass remained
        // visible outside the spectrum-painted DOM chip.
        let (left_span, right_span) = compact_side_spans(host_width, left, right)?;
        let (frame_height, _) = compact_side_vertical_geometry(host_height);
        let frame_y = bounds.origin.y + HARDWARE_SIDE_VERTICAL_INSET;
        Some((
            NSRect {
                origin: NSPoint {
                    x: bounds.origin.x + left_span.x,
                    y: frame_y,
                },
                size: NSSize {
                    width: left_span.width,
                    height: frame_height,
                },
            },
            NSRect {
                origin: NSPoint {
                    x: bounds.origin.x + right_span.x,
                    y: frame_y,
                },
                size: NSSize {
                    width: right_span.width,
                    height: frame_height,
                },
            },
        ))
    }

    /// Build one native alpha mask containing both camera-side compact pills.
    ///
    /// Floating compact mode uses one `NSVisualEffectView`; using that same
    /// effect instance topology here keeps material sampling and tint
    /// identical. Only the mask geometry differs, leaving the system-owned
    /// camera interval fully transparent without maintaining two separately
    /// composited vibrancy views.
    fn compact_side_mask(
        bounds: NSRect,
        left_frame: NSRect,
        right_frame: NSRect,
        radius: f64,
    ) -> Option<Retained<NSImage>> {
        if !bounds.size.width.is_finite()
            || !bounds.size.height.is_finite()
            || bounds.size.width <= 0.0
            || bounds.size.height <= 0.0
            || !radius.is_finite()
            || radius <= 0.0
        {
            return None;
        }
        let local_frame = |frame: NSRect| NSRect {
            origin: NSPoint {
                x: frame.origin.x - bounds.origin.x,
                y: frame.origin.y - bounds.origin.y,
            },
            size: frame.size,
        };
        let left = local_frame(left_frame);
        let right = local_frame(right_frame);
        let drawing_handler = RcBlock::new(move |_destination: NSRect| -> Bool {
            NSColor::whiteColor().setFill();
            NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(left, radius, radius).fill();
            NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(right, radius, radius).fill();
            Bool::YES
        });
        Some(NSImage::imageWithSize_flipped_drawingHandler(
            bounds.size,
            true,
            &drawing_handler,
        ))
    }

    /// Install/update the native AppKit vibrancy surfaces used by the
    /// expanded shelf, the no-notch fallback capsule, and each compact side
    /// chip. The side surfaces stop at the measured camera gap; a full-width
    /// native view in compact hardware mode would paint over the system-owned
    /// black notch.
    fn sync_native_glass_surface(
        window: &NSWindow,
        raw_webview: *mut std::ffi::c_void,
        surface_mode: SurfaceMode,
        hardware_notch: Option<bool>,
        placement_mode: PlacementMode,
        medium_header_owned_by_companion: bool,
    ) -> bool {
        if raw_webview.is_null() {
            return false;
        }
        let webview: &NSView = unsafe { &*raw_webview.cast() };
        if matches!(placement_mode, PlacementMode::Floating) {
            let bounds = webview.bounds();
            if !bounds.size.width.is_finite()
                || !bounds.size.height.is_finite()
                || bounds.size.width <= 0.0
                || bounds.size.height <= 0.0
            {
                hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
                hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
                hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
                return false;
            }
            hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
            hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
            let radius = match surface_mode {
                SurfaceMode::Compact => FALLBACK_GLASS_RADIUS,
                SurfaceMode::Medium => MEDIUM_GLASS_RADIUS,
                SurfaceMode::Expanded | SurfaceMode::Transition => EXPANDED_GLASS_RADIUS,
            };
            return ensure_glass_view(webview, bounds, NATIVE_GLASS_VIEW_TAG, radius, None)
                .is_some();
        }
        // The renderer owns the visible transform during a size transition.
        // Hide every native material for those few frames so AppKit cannot
        // reveal the target-sized glass before the WebView reaches it. Keep
        // the views cached to avoid allocation/filter compilation on settle.
        if matches!(surface_mode, SurfaceMode::Transition) {
            hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
            hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
            hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
            return true;
        }
        // Medium hardware mode uses one masked effect view: its alpha contour
        // joins both side shoulders to the body below while leaving the real
        // camera gap untouched. Unknown display state stays fully clear rather
        // than briefly inventing a notch shape from fallback dimensions.
        if matches!(surface_mode, SurfaceMode::Medium) && matches!(hardware_notch, Some(true)) {
            hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
            hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
            let Some(mtm) = MainThreadMarker::new() else {
                hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
                return false;
            };
            let Some(screen) = screen_for_window(window, mtm) else {
                hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
                return false;
            };
            if let Some(mask) =
                medium_contour_mask(window, webview, &screen, medium_header_owned_by_companion)
            {
                return ensure_glass_view(
                    webview,
                    webview.bounds(),
                    NATIVE_GLASS_VIEW_TAG,
                    0.0,
                    Some(&mask),
                )
                .is_some();
            } else {
                hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
            }
            return false;
        }
        if matches!(surface_mode, SurfaceMode::Medium) && hardware_notch.is_none() {
            hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
            hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
            hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
            return false;
        }

        let full_surface = !matches!(surface_mode, SurfaceMode::Compact);

        // Until AppKit identifies the display, a full-width fallback material
        // could briefly cover a real camera gap. A confirmed hardware notch is
        // not deferred: it must continue into the two-side material branch
        // below instead of leaving the compact text over a nearly clear view.
        if should_defer_compact_native_glass(surface_mode, hardware_notch) {
            hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
            hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
            hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
            return false;
        }

        let bounds = webview.bounds();
        let width = bounds.size.width;
        let height = bounds.size.height;
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return false;
        }

        // A real-notch compact host uses the same single Popover material as
        // floating compact mode. Its native alpha mask exposes that material
        // only beneath the two side pills, so the middle camera interval stays
        // system-owned without changing the glass recipe between placements.
        if matches!(surface_mode, SurfaceMode::Compact) && matches!(hardware_notch, Some(true)) {
            let Some(mtm) = MainThreadMarker::new() else {
                hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
                hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
                hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
                return false;
            };
            let Some(screen) = screen_for_window(window, mtm) else {
                hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
                hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
                hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
                return false;
            };
            let Some((left_frame, right_frame)) = compact_side_frames(window, webview, &screen)
            else {
                hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
                hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
                hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
                return false;
            };
            let (_, compact_radius) = compact_side_vertical_geometry(bounds.size.height);
            let Some(mask) = compact_side_mask(bounds, left_frame, right_frame, compact_radius)
            else {
                hide_glass_view(webview, NATIVE_GLASS_VIEW_TAG);
                hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
                hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
                return false;
            };
            hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
            hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);
            return ensure_glass_view(webview, bounds, NATIVE_GLASS_VIEW_TAG, 0.0, Some(&mask))
                .is_some();
        }

        hide_glass_view(webview, NATIVE_GLASS_LEFT_TAG);
        hide_glass_view(webview, NATIVE_GLASS_RIGHT_TAG);

        // The CSS fallback capsule is inset six logical points from the
        // top of its 38pt bootstrap host. Match that inset here so the
        // native material cannot leak into the transparent top gutter.
        let top_inset = if full_surface {
            0.0
        } else {
            FALLBACK_GLASS_TOP_INSET.min((height - 1.0).max(0.0))
        };
        let frame = NSRect {
            origin: NSPoint {
                x: bounds.origin.x,
                y: bounds.origin.y,
            },
            size: NSSize {
                width,
                height: (height - top_inset).max(1.0),
            },
        };
        let radius = match surface_mode {
            // A non-notched display renders the standalone medium page across
            // the full host. Keep AppKit's material radius identical to that
            // page instead of inheriting the larger expanded-shelf radius.
            SurfaceMode::Medium => MEDIUM_GLASS_RADIUS,
            SurfaceMode::Expanded => EXPANDED_GLASS_RADIUS,
            SurfaceMode::Compact | SurfaceMode::Transition => FALLBACK_GLASS_RADIUS,
        };

        ensure_glass_view(webview, frame, NATIVE_GLASS_VIEW_TAG, radius, None).is_some()
    }

    fn screen_for_window(
        window: &NSWindow,
        mtm: MainThreadMarker,
    ) -> Option<objc2::rc::Retained<NSScreen>> {
        if let Some(screen) = window.screen() {
            return Some(screen);
        }

        // A hidden window may not report `screen` yet. Choose the display
        // containing its frame centre before falling back to AppKit's main
        // screen; this avoids silently moving a multi-monitor widget to the
        // wrong display during its first show.
        let frame = window.frame();
        let center = NSPoint {
            x: frame.origin.x + frame.size.width / 2.0,
            y: frame.origin.y + frame.size.height / 2.0,
        };
        let screens = NSScreen::screens(mtm);
        screens
            .to_vec()
            .into_iter()
            .find(|screen| point_is_inside_rect(center, screen.frame()))
            .or_else(|| NSScreen::mainScreen(mtm))
    }

    fn webview_alpha_value(raw_webview: *mut std::ffi::c_void) -> Option<f64> {
        if raw_webview.is_null() {
            return None;
        }
        let webview: &NSView = unsafe { &*raw_webview.cast() };
        let alpha = webview.alphaValue();
        alpha.is_finite().then(|| alpha.clamp(0.0, 1.0))
    }

    fn geometry_for_window(
        window: &NSWindow,
        screen: &NSScreen,
        raw_webview: *mut std::ffi::c_void,
    ) -> MacNotchGeometry {
        let screen_frame_raw = screen.frame();
        let visible_frame_raw = screen.visibleFrame();
        // These three NSScreen APIs were introduced in macOS 12. Keep the
        // deployment target compatible with older Tauri builds and take the
        // documented zero-inset fallback when the selector is unavailable.
        let (safe_top, safe_left, safe_bottom, safe_right, auxiliary_left, auxiliary_right) =
            if objc2::available!(macos = 12.0, ..) {
                let (safe_top, safe_left, safe_bottom, safe_right) =
                    edge_insets(screen.safeAreaInsets());
                (
                    safe_top,
                    safe_left,
                    safe_bottom,
                    safe_right,
                    rect(screen.auxiliaryTopLeftArea()),
                    rect(screen.auxiliaryTopRightArea()),
                )
            } else {
                (
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    MacNotchRect::default(),
                    MacNotchRect::default(),
                )
            };
        let screen_frame = rect(screen_frame_raw);
        let visible_frame = rect(visible_frame_raw);

        // On a notched Mac, AppKit reports the camera cut-out as the gap
        // between the two auxiliary top areas. On a non-notched display those
        // areas are zero-sized, so use a conservative shelf width instead.
        let notch_bounds = inferred_notch_bounds(screen_frame, auxiliary_left, auxiliary_right);
        let inferred_notch_width = notch_bounds
            .map(|(left, right)| right - left)
            .unwrap_or(0.0);
        // A positive top safe-area alone is not sufficient: on some external
        // displays it can describe a system inset while both auxiliary areas
        // are empty. Only call it hardware notch geometry when the central gap
        // is non-zero and narrower than the full screen.
        let has_hardware_notch = safe_top > 0.0 && notch_bounds.is_some();
        let menu_bar_height = (screen_frame.y + screen_frame.height
            - (visible_frame.y + visible_frame.height))
            .max(0.0);
        let notch_height = if has_hardware_notch { safe_top } else { 0.0 };
        // Keep the exact gap as a diagnostic while deriving a slightly wider
        // host whose closed height follows the measured safe area.
        let (closed_width, closed_height) = compact_host_size(
            screen_frame.width,
            screen_frame.height,
            safe_top,
            menu_bar_height,
            inferred_notch_width,
            has_hardware_notch,
        );
        let backing_scale_factor = {
            let scale = screen.backingScaleFactor();
            if scale.is_finite() && scale > 0.0 {
                scale
            } else {
                1.0
            }
        };

        MacNotchGeometry {
            schema_version: 1,
            source: SOURCE.to_string(),
            updated_at: now_millis(),
            supported: true,
            host_kind: "NSWindow".to_string(),
            screen_name: Some(screen.localizedName().to_string()),
            has_hardware_notch,
            notch_width: if has_hardware_notch {
                inferred_notch_width
            } else {
                0.0
            },
            notch_height,
            menu_bar_height,
            closed_width,
            closed_height,
            safe_area_top: safe_top,
            safe_area_left: safe_left,
            safe_area_bottom: safe_bottom,
            safe_area_right: safe_right,
            auxiliary_top_left_width: auxiliary_left.width,
            auxiliary_top_right_width: auxiliary_right.width,
            backing_scale_factor,
            screen_frame,
            visible_frame,
            window_frame: Some(rect(window.frame())),
            window_level: Some(window.level() as i64),
            window_style_mask: Some(window.styleMask().0 as u64),
            window_collection_behavior: Some(window.collectionBehavior().0 as u64),
            window_is_opaque: Some(window.isOpaque()),
            window_has_shadow: Some(window.hasShadow()),
            window_is_movable: Some(window.isMovable()),
            window_is_key: Some(window.isKeyWindow()),
            webview_alpha_value: webview_alpha_value(raw_webview),
            window_ignores_mouse_events: Some(window.ignoresMouseEvents()),
            window_accepts_mouse_moved_events: Some(window.acceptsMouseMovedEvents()),
            crown_companion_visible: None,
            limitation: if has_hardware_notch {
                Some(
                    "摄像头安全区几何来自 AppKit；中央摄像头外壳由系统拥有，应用只在两侧显示基础信息并在展开时绘制自有窗口。"
                        .to_string(),
                )
            } else {
                Some("当前显示器未检测到摄像头外壳，紧凑视图使用顶部胶囊兼容布局。".to_string())
            },
        }
    }

    type WindowResult<T> = Result<T, String>;
    type WindowResultChannel<T> = (SyncSender<WindowResult<T>>, Receiver<WindowResult<T>>);

    fn with_native_result<R, T, F>(window: &WebviewWindow<R>, operation: F) -> Result<T, String>
    where
        R: Runtime,
        T: Send + 'static,
        F: FnOnce(&NSWindow, *mut std::ffi::c_void) -> Result<T, String> + Send + 'static,
    {
        let (sender, receiver): WindowResultChannel<T> = sync_channel(1);
        window
            .with_webview(move |webview| {
                let result = (|| {
                    let raw_window = webview.ns_window();
                    if raw_window.is_null() {
                        return Err("AppKit 未返回 widget 宿主 NSWindow。".to_string());
                    }
                    // `with_webview` documents that this closure runs on the
                    // AppKit main thread; the pointer is valid for its scope.
                    let native_window: &NSWindow = unsafe { &*raw_window.cast() };
                    operation(native_window, webview.inner())
                })();
                let _ = sender.send(result);
            })
            .map_err(|error| format!("访问 widget 宿主 NSWindow 失败：{error}"))?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| format!("AppKit 主线程未及时返回 widget 窗口结果：{error}"))?
    }

    fn with_window_result<R, T, F>(window: &WebviewWindow<R>, operation: F) -> Result<T, String>
    where
        R: Runtime,
        T: Send + 'static,
        F: FnOnce(&NSWindow) -> Result<T, String> + Send + 'static,
    {
        with_native_result(window, move |native_window, _raw_webview| {
            operation(native_window)
        })
    }

    fn geometry_from_window<R: Runtime>(
        window: &WebviewWindow<R>,
    ) -> Result<MacNotchGeometry, String> {
        with_native_result(window, |native_window, raw_webview| {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "AppKit 窗口回调未运行在主线程。".to_string())?;
            let screen = screen_for_window(native_window, mtm).ok_or_else(|| {
                "AppKit 当前没有可用 NSScreen（widget 可能仍在初始化）。".to_string()
            })?;
            Ok(geometry_for_window(native_window, &screen, raw_webview))
        })
    }

    pub(super) fn get<R: Runtime>(app: &AppHandle<R>) -> Result<MacNotchGeometry, String> {
        let Some(window) = app.get_webview_window(WIDGET_LABEL) else {
            return Ok(fallback_geometry(
                "appkit.unavailable",
                false,
                Some("widget 窗口尚未创建。"),
            ));
        };
        geometry_from_window(&window)
    }

    fn pointer_proximity_for_window(window: &NSWindow, margin: f64) -> MacPointerProximity {
        let pointer = NSEvent::mouseLocation();
        let frame = window.frame();
        let frame_rect = rect(frame);
        let window_visible = window.isVisible();
        let near_window =
            window_visible && point_is_near_rect(pointer.x, pointer.y, frame_rect, margin);
        let screen_name = MainThreadMarker::new()
            .and_then(|mtm| screen_for_window(window, mtm))
            .map(|screen| screen.localizedName().to_string());
        MacPointerProximity {
            schema_version: 1,
            source: SOURCE.to_string(),
            supported: true,
            pointer_x: pointer.x,
            pointer_y: pointer.y,
            margin,
            window_visible,
            near_window,
            screen_name,
            window_frame: Some(frame_rect),
            limitation: Some(
                "指针与窗口命中区均使用 AppKit 全局逻辑点；不经过 tao 的 Retina 物理像素换算。"
                    .to_string(),
            ),
        }
    }

    pub(super) fn pointer_proximity<R: Runtime>(
        app: &AppHandle<R>,
        margin: Option<f64>,
    ) -> Result<MacPointerProximity, String> {
        let Some(window) = app.get_webview_window(WIDGET_LABEL) else {
            return Ok(fallback_pointer_proximity(
                "appkit.unavailable",
                Some("widget 窗口尚未创建。"),
            ));
        };
        let margin = margin.unwrap_or(34.0);
        if !margin.is_finite() || !(0.0..=512.0).contains(&margin) {
            return Err("指针命中余量必须是 0 到 512 之间的有限 AppKit 逻辑点。".to_string());
        }
        with_window_result(&window, move |native_window| {
            Ok(pointer_proximity_for_window(native_window, margin))
        })
    }

    /// Keep only the camera-side status band above ordinary application
    /// windows while the larger medium body remains coverable. The companion
    /// is a separate transparent WebView because NSWindow.level cannot differ
    /// between sibling NSViews inside the main host.
    fn sync_crown_companion<R: Runtime>(
        app: &AppHandle<R>,
        geometry: &MacNotchGeometry,
        placement_mode: PlacementMode,
        surface_mode: Option<SurfaceMode>,
        requested_always_on_top: Option<bool>,
        main_window_visible: bool,
    ) -> Result<bool, String> {
        let Some(crown) = app.get_webview_window(WIDGET_CROWN_LABEL) else {
            // The first native bootstrap may run immediately before widget.rs
            // finishes constructing the hidden companion. The next explicit
            // frontend sync will configure it, so absence here is benign.
            return Ok(false);
        };
        let should_show = should_show_crown_companion(
            placement_mode,
            surface_mode,
            requested_always_on_top,
            geometry.has_hardware_notch,
            main_window_visible,
        );
        if !should_show {
            crown
                .hide()
                .map_err(|error| format!("隐藏顶部状态伴随窗口失败：{error}"))?;
            return Ok(false);
        }

        let frame = crown_companion_frame(geometry)
            .ok_or_else(|| "AppKit 未能从摘要窗口计算顶部状态伴随区域。".to_string())?;
        let full_surface_height = geometry
            .window_frame
            .map(|main| main.height)
            .unwrap_or(224.0);
        let configured = with_native_result(&crown, move |native_window, raw_webview| {
            // AppKit can constrain a normal-level borderless window below the
            // menu bar. Establish the camera-safe level before assigning the
            // top-edge frame, matching the ordering used by the main host.
            apply_window_level(
                native_window,
                PlacementMode::Notch,
                Some(SurfaceMode::Compact),
                Some(true),
            );
            native_window.setFrame_display_animate(
                NSRect {
                    origin: NSPoint {
                        x: frame.x,
                        y: frame.y,
                    },
                    size: NSSize {
                        width: frame.width,
                        height: frame.height,
                    },
                },
                true,
                false,
            );
            // Configure the exact original medium crop directly. No compact
            // pill material is created on this path, so the first presented
            // frame already has the correct unified contour.
            Ok(configure_crown_host(
                native_window,
                raw_webview,
                full_surface_height,
            ))
        })?;
        if !configured {
            crown
                .hide()
                .map_err(|error| format!("伴随层材质不可用且无法隐藏：{error}"))?;
        }
        Ok(configured)
    }

    /// Show the already-created widget without routing through Tauri's
    /// `Window::show()`, whose macOS implementation may call
    /// `makeKeyAndOrderFront` and steal focus from the user's current app.
    /// `orderFrontRegardless` orders the surface while preserving the native
    /// panel-style hint configured above. The host is still an NSWindow, so
    /// this is a best-effort focus improvement rather than a true NSPanel
    /// `canBecomeKey` override.
    pub(super) fn show<R: Runtime>(
        app: &AppHandle<R>,
        always_on_top: bool,
        interactive: bool,
        surface_mode: Option<SurfaceMode>,
    ) -> Result<(), String> {
        let Some(window) = app.get_webview_window(WIDGET_LABEL) else {
            return Err("找不到 widget 窗口，无法通过 AppKit 显示。".to_string());
        };
        with_native_result(&window, move |native_window, raw_webview| {
            // `show` predates placementMode. Preserve a floating host across
            // hide/show by reading the movable flag owned by this bridge;
            // initial/legacy notch windows remain non-movable.
            let placement_mode = resolve_placement_mode(None, native_window.isMovable());
            let _ = configure_host_window(
                native_window,
                raw_webview,
                true,
                Some(always_on_top),
                Some(interactive),
                surface_mode,
                placement_mode,
                false,
            );
            Ok(())
        })
    }

    fn notch_center_x(screen: &NSScreen, screen_frame: MacNotchRect) -> Option<f64> {
        if !objc2::available!(macos = 12.0, ..) {
            return None;
        }
        let auxiliary_left = rect(screen.auxiliaryTopLeftArea());
        let auxiliary_right = rect(screen.auxiliaryTopRightArea());
        inferred_notch_bounds(screen_frame, auxiliary_left, auxiliary_right)
            .map(|(left, right)| (left + right) / 2.0)
    }

    // The bridge mirrors the existing IPC fields to keep old callers source
    // compatible; grouping them into a request object would change that wire
    // contract solely to satisfy a lint threshold.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn sync<R: Runtime>(
        app: &AppHandle<R>,
        width: Option<f64>,
        height: Option<f64>,
        animate: Option<bool>,
        always_on_top: Option<bool>,
        interactive: Option<bool>,
        surface_mode: Option<SurfaceMode>,
        placement_mode: Option<PlacementMode>,
        floating_anchor: Option<MacNotchRect>,
        crown_content_ready: Option<bool>,
    ) -> Result<MacNotchGeometry, String> {
        let Some(window) = app.get_webview_window(WIDGET_LABEL) else {
            return Err("找不到 widget 窗口，无法同步 AppKit 几何。".to_string());
        };

        let width = width
            .map(|value| {
                if value.is_finite() && value > 0.0 {
                    Ok(value)
                } else {
                    Err("widget 宽度必须是有限的正数（AppKit 逻辑点）。".to_string())
                }
            })
            .transpose()?;
        let height = height
            .map(|value| {
                if value.is_finite() && value > 0.0 {
                    Ok(value)
                } else {
                    Err("widget 高度必须是有限的正数（AppKit 逻辑点）。".to_string())
                }
            })
            .transpose()?;
        let requested_placement_mode = placement_mode;
        let requested_animate = animate.unwrap_or(false);
        if matches!(requested_placement_mode, Some(PlacementMode::Floating)) {
            // Tauri's macOS subclass keeps a separate canBecomeKey flag. The
            // AppKit style/mouse policy below is not sufficient for keyboard
            // controls if an earlier notch presentation disabled focusability.
            window
                .set_focusable(true)
                .map_err(|error| format!("启用浮动窗口键盘交互失败：{error}"))?;
        }

        let main_window_visible = window.is_visible().unwrap_or(false);
        // A physical crown window is not sufficient to remove the main
        // header. The current companion WebView session must also have crossed
        // a paint boundary for this presentation. Until both are true the
        // complete main surface remains at the camera-safe level.
        let retain_crown_ownership = crown_content_ready.unwrap_or(false)
            && app
                .get_webview_window(WIDGET_CROWN_LABEL)
                .and_then(|crown| crown.is_visible().ok())
                .unwrap_or(false);
        let geometry_result = with_native_result(&window, move |native_window, raw_webview| {
            // Backend lifecycle calls predate placementMode. Preserve an
            // already-detached window instead of silently snapping it back to
            // the notch; a fresh/legacy non-movable host still defaults to the
            // original notch behavior.
            let placement_mode =
                resolve_placement_mode(requested_placement_mode, native_window.isMovable());
            // A detached utility window must resize in place. Ignore a stale
            // caller-supplied animation flag instead of allowing AppKit to
            // slide the frame while the user is positioning it.
            let animate = requested_animate && matches!(placement_mode, PlacementMode::Notch);
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "AppKit 窗口回调未运行在主线程。".to_string())?;
            let screen = screen_for_window(native_window, mtm)
                .ok_or_else(|| "AppKit 当前没有可用 NSScreen，无法定位 widget。".to_string())?;
            let crown_candidate = should_show_crown_companion(
                placement_mode,
                surface_mode,
                always_on_top,
                measured_screen_has_hardware_notch(&screen),
                main_window_visible,
            );
            let medium_header_owned_by_companion = crown_candidate && retain_crown_ownership;
            // Before the companion has both a native surface and current
            // painted content, keep the complete main summary at the
            // camera-safe level. Once ownership is confirmed, the requested
            // coverable level is applied atomically with the body-only mask.
            let effective_always_on_top = if crown_candidate && !medium_header_owned_by_companion {
                Some(true)
            } else {
                always_on_top
            };
            // Apply the level before the frame. A low-level borderless window
            // can otherwise be constrained below the menu-bar safe area.
            apply_window_level(
                native_window,
                placement_mode,
                surface_mode,
                effective_always_on_top,
            );
            let screen_frame = screen.frame();
            let screen_frame_rect = rect(screen_frame);
            let current_frame = native_window.frame();
            let target_width = width.unwrap_or(current_frame.size.width);
            let target_height = height.unwrap_or(current_frame.size.height);
            let target_frame_rect = match placement_mode {
                PlacementMode::Notch => {
                    let center_x = notch_center_x(&screen, screen_frame_rect)
                        .unwrap_or(screen_frame.origin.x + screen_frame.size.width / 2.0);
                    MacNotchRect {
                        x: center_x - target_width / 2.0,
                        y: screen_frame.origin.y + screen_frame.size.height - target_height,
                        width: target_width,
                        height: target_height,
                    }
                }
                PlacementMode::Floating => floating_target_frame(
                    floating_anchor.unwrap_or_else(|| rect(current_frame)),
                    rect(screen.visibleFrame()),
                    target_width,
                    target_height,
                )
                .ok_or_else(|| {
                    "AppKit 当前显示器没有可用的 visibleFrame，无法定位浮动窗口。".to_string()
                })?,
            };
            let target_frame = NSRect {
                origin: NSPoint {
                    x: target_frame_rect.x,
                    y: target_frame_rect.y,
                },
                size: NSSize {
                    width: target_frame_rect.width,
                    height: target_frame_rect.height,
                },
            };

            // Transition-mode calls often change only material/hit policy at
            // the current size. Asking WindowServer to redisplay an identical
            // frame adds a main-thread/window-compositor round trip exactly at
            // animation start, so skip sub-quarter-point no-op frames.
            if !rects_nearly_equal(rect(current_frame), rect(target_frame), 0.25) {
                native_window.setFrame_display_animate(target_frame, true, animate);
            }
            // Configure the material after AppKit has applied the target
            // frame.  The compact hardware path derives the two native side
            // surfaces from the current window bounds; doing that before the
            // resize would briefly use the previous expanded/compact origin
            // and could stretch a glass view across the camera gap during a
            // fast reversal. A hidden window is still configured without
            // ordering it; after Tauri makes it visible, the next sync uses
            // orderFrontRegardless without requesting key focus again.
            let main_material_ready = configure_host_window(
                native_window,
                raw_webview,
                // Routine presentation sync must not reorder an already
                // visible window. The explicit show path is the sole owner of
                // orderFrontRegardless; material/geometry updates stay local.
                false,
                effective_always_on_top,
                interactive,
                surface_mode,
                placement_mode,
                medium_header_owned_by_companion,
            );
            Ok((
                geometry_for_window(native_window, &screen, raw_webview),
                main_material_ready,
            ))
        })?;
        let (mut geometry, main_material_ready) = geometry_result;
        let resolved_placement_mode = resolve_placement_mode(
            requested_placement_mode,
            geometry.window_is_movable.unwrap_or(false),
        );
        let crown_expected = should_show_crown_companion(
            resolved_placement_mode,
            surface_mode,
            always_on_top,
            geometry.has_hardware_notch,
            main_window_visible,
        );
        let mut crown_visible = match sync_crown_companion(
            app,
            &geometry,
            resolved_placement_mode,
            surface_mode,
            always_on_top,
            main_window_visible,
        ) {
            Ok(visible) => visible,
            Err(error) => {
                // The crown is an optional enhancement. A creation, mask or
                // hide failure must never turn a successful main-widget sync
                // into a total failure or make the renderer discard geometry.
                eprintln!("顶部状态伴随层已降级：{error}");
                if let Some(crown) = app.get_webview_window(WIDGET_CROWN_LABEL) {
                    let _ = crown.hide();
                }
                false
            }
        };

        if crown_visible && retain_crown_ownership && !main_material_ready {
            // Never acknowledge ownership when the lower body-only material
            // could not be installed. Keep one complete surface instead of a
            // high-level header attached to a partially rendered body.
            if let Some(crown) = app.get_webview_window(WIDGET_CROWN_LABEL) {
                let _ = crown.hide();
            }
            crown_visible = false;
        }

        if !crown_visible && crown_expected {
            // Creation/mask/display failure is an optional-feature failure.
            // Honour the requested coverable level, restore the full main
            // contour and return usable geometry instead of failing the app.
            let current_hardware_notch = Some(geometry.has_hardware_notch);
            match with_native_result(&window, move |native_window, raw_webview| {
                apply_window_level(
                    native_window,
                    resolved_placement_mode,
                    surface_mode,
                    always_on_top,
                );
                let restored = sync_native_glass_surface(
                    native_window,
                    raw_webview,
                    SurfaceMode::Medium,
                    current_hardware_notch,
                    resolved_placement_mode,
                    false,
                );
                let mtm = MainThreadMarker::new()
                    .ok_or_else(|| "AppKit 降级恢复未运行在主线程。".to_string())?;
                let screen = screen_for_window(native_window, mtm)
                    .ok_or_else(|| "AppKit 降级恢复找不到当前显示器。".to_string())?;
                Ok((
                    geometry_for_window(native_window, &screen, raw_webview),
                    restored,
                ))
            }) {
                Ok((restored_geometry, _)) => geometry = restored_geometry,
                Err(error) => eprintln!("主摘要完整材质恢复失败：{error}"),
            }
        }

        // `crown_visible` proves that AppKit installed and ordered the native
        // crop. `retain_crown_ownership` proves that this exact frontend
        // presentation was painted. If the crop only became visible during
        // this call, return false and let the renderer issue one immediate
        // second sync; the main surface stays complete until then.
        geometry.crown_companion_visible =
            Some(crown_visible && retain_crown_ownership && main_material_ready);
        Ok(geometry)
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub(super) fn get<R: Runtime>(_app: &AppHandle<R>) -> Result<MacNotchGeometry, String> {
        Ok(fallback_geometry(
            "unsupported",
            false,
            Some("AppKit 屏幕几何仅在 macOS 桌面版可用。"),
        ))
    }

    pub(super) fn pointer_proximity<R: Runtime>(
        _app: &AppHandle<R>,
        _margin: Option<f64>,
    ) -> Result<MacPointerProximity, String> {
        Ok(fallback_pointer_proximity(
            "unsupported",
            Some("AppKit 指针坐标仅在 macOS 桌面版可用。"),
        ))
    }

    pub(super) fn sync<R: Runtime>(
        _app: &AppHandle<R>,
        _width: Option<f64>,
        _height: Option<f64>,
        _animate: Option<bool>,
        _always_on_top: Option<bool>,
        _interactive: Option<bool>,
        _surface_mode: Option<SurfaceMode>,
        _placement_mode: Option<PlacementMode>,
        _floating_anchor: Option<MacNotchRect>,
        _crown_content_ready: Option<bool>,
    ) -> Result<MacNotchGeometry, String> {
        // Keep the command a no-op on other targets so shared frontend code
        // can still run in browser/mobile test builds without cfg branching.
        get(_app)
    }
}

/// Read the current AppKit screen and widget-host geometry.
#[tauri::command]
pub fn get_macos_notch_geometry(app: AppHandle) -> Result<MacNotchGeometry, String> {
    platform::get(&app)
}

/// Sample the pointer and test proximity to the widget in AppKit's global
/// logical-point coordinate space. This avoids tao's primary-display/physical
/// pixel conversion mismatch on mixed-scale macOS displays.
#[tauri::command]
pub fn get_macos_pointer_proximity(
    app: AppHandle,
    margin: Option<f64>,
) -> Result<MacPointerProximity, String> {
    platform::pointer_proximity(&app, margin)
}

/// Apply an AppKit logical-point size and return the resulting geometry.
/// A fresh/legacy non-movable host defaults to `notch`, preserving the original
/// top-centred behavior. Omitting the field on an already-floating host keeps
/// that placement so old backend lifecycle helpers do not destroy its position.
/// `floating` keeps the current centre, clamps the complete window to the
/// display's visible frame, and always applies the resize without animation.
#[tauri::command]
// Keep each field optional at the command boundary so older frontend builds
// can omit `placementMode` without migrating to a nested request payload.
#[allow(clippy::too_many_arguments)]
pub fn sync_macos_widget_window(
    app: AppHandle,
    width: Option<f64>,
    height: Option<f64>,
    animate: Option<bool>,
    always_on_top: Option<bool>,
    interactive: Option<bool>,
    surface_mode: Option<SurfaceMode>,
    placement_mode: Option<PlacementMode>,
    floating_anchor: Option<MacNotchRect>,
    crown_content_ready: Option<bool>,
) -> Result<MacNotchGeometry, String> {
    platform::sync(
        &app,
        width,
        height,
        animate,
        always_on_top,
        interactive,
        surface_mode,
        placement_mode,
        floating_anchor,
        crown_content_ready,
    )
}

/// Native helper for backend window lifecycle code.
///
/// Unlike the Tauri command this accepts a borrowed, generic-runtime handle so
/// `widget.rs` can re-anchor the window immediately before/after `show()`
/// without going through an IPC round trip. The AppKit object itself remains
/// scoped to `with_webview`; only the serializable geometry crosses the call.
pub fn sync_widget_window_for_app<R: Runtime>(
    app: &AppHandle<R>,
    width: Option<f64>,
    height: Option<f64>,
    animate: bool,
    always_on_top: Option<bool>,
    interactive: Option<bool>,
) -> Result<MacNotchGeometry, String> {
    platform::sync(
        app,
        width,
        height,
        Some(animate),
        always_on_top,
        interactive,
        None,
        None,
        None,
        None,
    )
}

/// Native lifecycle helper used by the widget module. This symbol is only
/// needed on macOS; other targets keep using their ordinary Tauri show path.
#[cfg(target_os = "macos")]
pub fn show_widget_window_for_app<R: Runtime>(
    app: &AppHandle<R>,
    always_on_top: bool,
    interactive: bool,
) -> Result<(), String> {
    platform::show(app, always_on_top, interactive, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_geometry_serializes_with_camel_case_fields() {
        let value = serde_json::to_value(fallback_geometry("test", false, None))
            .expect("geometry should serialize");
        assert_eq!(value["hasHardwareNotch"], false);
        assert!(value.get("has_hardware_notch").is_none());
        assert!(value.get("backingScaleFactor").is_some());
        assert!(value.get("screenFrame").is_some());
        assert_eq!(value["crownCompanionVisible"], serde_json::Value::Null);
    }

    #[test]
    fn surface_mode_uses_stable_wire_names() {
        assert_eq!(
            serde_json::to_value(SurfaceMode::Compact).expect("mode should serialize"),
            serde_json::json!("compact")
        );
        assert_eq!(
            serde_json::from_value::<SurfaceMode>(serde_json::json!("medium"))
                .expect("mode should deserialize"),
            SurfaceMode::Medium
        );
        assert_eq!(
            serde_json::to_value(SurfaceMode::Transition).expect("mode should serialize"),
            serde_json::json!("transition")
        );
    }

    #[test]
    fn placement_mode_defaults_to_notch_and_uses_stable_wire_names() {
        assert_eq!(PlacementMode::default(), PlacementMode::Notch);
        assert_eq!(
            serde_json::to_value(PlacementMode::Notch).expect("mode should serialize"),
            serde_json::json!("notch")
        );
        assert_eq!(
            serde_json::from_value::<PlacementMode>(serde_json::json!("floating"))
                .expect("mode should deserialize"),
            PlacementMode::Floating
        );
    }

    #[test]
    fn omitted_placement_preserves_an_existing_floating_window() {
        assert_eq!(resolve_placement_mode(None, false), PlacementMode::Notch);
        assert_eq!(resolve_placement_mode(None, true), PlacementMode::Floating);
        assert_eq!(
            resolve_placement_mode(Some(PlacementMode::Notch), true),
            PlacementMode::Notch
        );
    }

    #[test]
    fn window_level_policy_preserves_camera_geometry_and_honours_medium_choice() {
        assert_eq!(
            resolve_window_level_policy(
                PlacementMode::Notch,
                Some(SurfaceMode::Compact),
                Some(false),
            ),
            WindowLevelPolicy::CameraSafeFront
        );
        assert_eq!(
            resolve_window_level_policy(
                PlacementMode::Notch,
                Some(SurfaceMode::Medium),
                Some(true),
            ),
            WindowLevelPolicy::CameraSafeFront
        );
        assert_eq!(
            resolve_window_level_policy(
                PlacementMode::Notch,
                Some(SurfaceMode::Medium),
                Some(false),
            ),
            WindowLevelPolicy::CoverableDesktop
        );
        assert_eq!(
            resolve_window_level_policy(
                PlacementMode::Notch,
                Some(SurfaceMode::Expanded),
                Some(false),
            ),
            WindowLevelPolicy::CameraSafeFront
        );
        assert_eq!(
            resolve_window_level_policy(PlacementMode::Notch, None, Some(false)),
            WindowLevelPolicy::CameraSafeFront
        );
        assert_eq!(
            resolve_window_level_policy(
                PlacementMode::Floating,
                Some(SurfaceMode::Medium),
                Some(false),
            ),
            WindowLevelPolicy::Standard
        );
        assert_eq!(
            resolve_window_level_policy(PlacementMode::Floating, Some(SurfaceMode::Compact), None,),
            WindowLevelPolicy::Preserve
        );
    }

    #[test]
    fn crown_companion_is_visible_only_for_coverable_hardware_medium() {
        assert!(should_show_crown_companion(
            PlacementMode::Notch,
            Some(SurfaceMode::Medium),
            Some(false),
            true,
            true,
        ));
        for candidate in [
            (
                PlacementMode::Notch,
                Some(SurfaceMode::Medium),
                Some(true),
                true,
                true,
            ),
            (
                PlacementMode::Notch,
                Some(SurfaceMode::Compact),
                Some(false),
                true,
                true,
            ),
            (
                PlacementMode::Notch,
                Some(SurfaceMode::Expanded),
                Some(false),
                true,
                true,
            ),
            (
                PlacementMode::Floating,
                Some(SurfaceMode::Medium),
                Some(false),
                true,
                true,
            ),
            (
                PlacementMode::Notch,
                Some(SurfaceMode::Medium),
                Some(false),
                false,
                true,
            ),
            (
                PlacementMode::Notch,
                Some(SurfaceMode::Medium),
                Some(false),
                true,
                false,
            ),
        ] {
            assert!(!should_show_crown_companion(
                candidate.0,
                candidate.1,
                candidate.2,
                candidate.3,
                candidate.4,
            ));
        }
    }

    #[test]
    fn crown_companion_covers_the_complete_menu_bar_occlusion_band() {
        let mut geometry = fallback_geometry("test", true, None);
        geometry.has_hardware_notch = true;
        geometry.notch_height = 28.0;
        geometry.menu_bar_height = 37.0;
        geometry.closed_height = 32.0;
        geometry.screen_frame = MacNotchRect {
            x: -1512.0,
            y: -200.0,
            width: 1512.0,
            height: 982.0,
        };
        geometry.window_frame = Some(MacNotchRect {
            x: -1036.0,
            y: 558.0,
            width: 560.0,
            height: 224.0,
        });

        let frame = crown_companion_frame(&geometry).expect("valid companion frame");
        assert_eq!(frame.x, -1036.0);
        assert_eq!(frame.y, 744.5);
        assert_eq!(frame.width, 560.0);
        assert_eq!(frame.height, 37.5);
    }

    #[test]
    fn crown_companion_uses_camera_height_when_it_exceeds_menu_bar_measurement() {
        let mut geometry = fallback_geometry("test", true, None);
        geometry.has_hardware_notch = true;
        geometry.notch_height = 32.0;
        geometry.menu_bar_height = 24.0;
        geometry.screen_frame = MacNotchRect {
            x: 0.0,
            y: 0.0,
            width: 1512.0,
            height: 982.0,
        };
        geometry.window_frame = Some(MacNotchRect {
            x: 476.0,
            y: 758.0,
            width: 560.0,
            height: 224.0,
        });

        let frame = crown_companion_frame(&geometry).expect("valid companion frame");
        assert_eq!(frame.y, 949.5);
        assert_eq!(frame.height, 32.5);
    }

    #[test]
    fn crown_companion_never_extends_beyond_the_medium_host() {
        let mut geometry = fallback_geometry("test", true, None);
        geometry.has_hardware_notch = true;
        geometry.notch_height = 32.0;
        geometry.menu_bar_height = 49.0;
        geometry.screen_frame = MacNotchRect {
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 40.0,
        };
        geometry.window_frame = Some(MacNotchRect {
            x: 0.0,
            y: 20.0,
            width: 320.0,
            height: 20.0,
        });

        let frame = crown_companion_frame(&geometry).expect("valid companion frame");
        assert_eq!(frame.y, 20.0);
        assert_eq!(frame.height, 20.0);
    }

    #[test]
    fn compact_native_glass_waits_only_for_unknown_hardware_state() {
        assert!(should_defer_compact_native_glass(
            SurfaceMode::Compact,
            None
        ));
        assert!(!should_defer_compact_native_glass(
            SurfaceMode::Compact,
            Some(true)
        ));
        assert!(!should_defer_compact_native_glass(
            SurfaceMode::Compact,
            Some(false)
        ));
        assert!(!should_defer_compact_native_glass(
            SurfaceMode::Medium,
            None
        ));
    }

    #[test]
    fn explicit_surface_mode_keeps_medium_passive() {
        let policy = resolve_surface_policy(Some(SurfaceMode::Medium), Some(true))
            .expect("explicit mode should resolve");
        assert_eq!(policy.mode, SurfaceMode::Medium);
        assert!(!policy.requested_interactive);
        assert!(!effective_interactive(
            policy.requested_interactive,
            Some(true)
        ));
        assert!(effective_interactive(
            policy.requested_interactive,
            Some(false)
        ));
    }

    #[test]
    fn transition_surface_is_passive_even_without_a_hardware_notch() {
        let policy = resolve_surface_policy(Some(SurfaceMode::Transition), Some(true))
            .expect("transition mode should resolve");
        assert_eq!(policy.mode, SurfaceMode::Transition);
        assert!(!policy.requested_interactive);
        assert!(!effective_policy_interactive(policy, Some(true)));
        assert!(!effective_policy_interactive(policy, Some(false)));
    }

    #[test]
    fn floating_placement_forces_interaction_for_every_surface_policy() {
        let passive = resolve_surface_policy(Some(SurfaceMode::Transition), Some(false))
            .expect("transition policy");
        assert!(effective_placement_interactive(
            PlacementMode::Floating,
            passive,
            Some(true)
        ));
        assert!(!effective_placement_interactive(
            PlacementMode::Notch,
            passive,
            Some(true)
        ));
    }

    #[test]
    fn subpixel_frame_differences_do_not_require_a_window_redisplay() {
        let current = MacNotchRect {
            x: 446.0,
            y: 440.0,
            width: 620.0,
            height: 460.0,
        };
        let compositor_rounding = MacNotchRect {
            x: 446.12,
            y: 439.88,
            width: 620.08,
            height: 459.92,
        };
        let real_resize = MacNotchRect {
            width: 500.0,
            height: 190.0,
            ..current
        };

        assert!(rects_nearly_equal(current, compositor_rounding, 0.25));
        assert!(!rects_nearly_equal(current, real_resize, 0.25));
    }

    #[test]
    fn floating_resize_preserves_the_current_center_when_it_fits() {
        let frame = floating_target_frame(
            MacNotchRect {
                x: 400.0,
                y: 200.0,
                width: 400.0,
                height: 300.0,
            },
            MacNotchRect {
                x: 0.0,
                y: 23.0,
                width: 1440.0,
                height: 877.0,
            },
            600.0,
            400.0,
        )
        .expect("valid floating frame");

        assert_eq!(frame.x, 300.0);
        assert_eq!(frame.y, 150.0);
        assert_eq!(frame.width, 600.0);
        assert_eq!(frame.height, 400.0);
    }

    #[test]
    fn floating_resize_clamps_to_an_offset_visible_frame() {
        let frame = floating_target_frame(
            MacNotchRect {
                x: -300.0,
                y: 900.0,
                width: 220.0,
                height: 100.0,
            },
            MacNotchRect {
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1057.0,
            },
            500.0,
            300.0,
        )
        .expect("valid offset display frame");

        assert_eq!(frame.x, -500.0);
        assert_eq!(frame.y, 757.0);
        assert_eq!(frame.width, 500.0);
        assert_eq!(frame.height, 300.0);
    }

    #[test]
    fn floating_resting_anchor_restores_the_original_position_after_edge_clamp() {
        let visible = MacNotchRect {
            x: 0.0,
            y: 23.0,
            width: 1440.0,
            height: 877.0,
        };
        let resting = MacNotchRect {
            x: 1190.0,
            y: 760.0,
            width: 220.0,
            height: 100.0,
        };
        let expanded = floating_target_frame(resting, visible, 620.0, 460.0)
            .expect("expanded frame should be clamped inside the display");
        let restored = floating_target_frame(resting, visible, resting.width, resting.height)
            .expect("cached resting anchor should remain valid");
        let drifted = floating_target_frame(expanded, visible, resting.width, resting.height)
            .expect("expanded centre remains a valid but incorrect fallback");

        assert_ne!(
            expanded.x + expanded.width / 2.0,
            resting.x + resting.width / 2.0
        );
        assert_eq!(restored, resting);
        assert_ne!(drifted, resting);
    }

    #[test]
    fn floating_resize_reduces_oversized_requests_to_the_visible_frame() {
        let visible = MacNotchRect {
            x: 100.0,
            y: 50.0,
            width: 800.0,
            height: 600.0,
        };
        let frame = floating_target_frame(
            MacNotchRect {
                x: 500.0,
                y: 400.0,
                width: 200.0,
                height: 100.0,
            },
            visible,
            1_200.0,
            900.0,
        )
        .expect("oversized requests should be bounded");

        assert_eq!(frame, visible);
    }

    #[test]
    fn legacy_interaction_remains_compatible_when_mode_is_absent() {
        let expanded = resolve_surface_policy(None, Some(true)).expect("legacy true");
        assert_eq!(expanded.mode, SurfaceMode::Expanded);
        assert!(expanded.requested_interactive);

        let compact = resolve_surface_policy(None, Some(false)).expect("legacy false");
        assert_eq!(compact.mode, SurfaceMode::Compact);
        assert!(!compact.requested_interactive);
        assert!(resolve_surface_policy(None, None).is_none());
    }

    #[test]
    fn medium_contour_wraps_the_real_gap_and_joins_below_it() {
        let contour = medium_contour_geometry(MediumContourSpec {
            width: 560.0,
            height: 224.0,
            header: 32.0,
            gap_left: 187.5,
            gap_right: 372.5,
            outer_inset: 8.0,
            bottom_inset: 8.0,
            top_inset: 3.0,
            notch_clearance: 5.0,
        })
        .expect("normal MacBook contour");
        assert_eq!(
            contour.left_shoulder,
            MacNotchRect {
                x: 8.0,
                y: 3.0,
                width: 174.5,
                height: 31.0,
            }
        );
        assert_eq!(contour.right_shoulder.x, 377.5);
        assert_eq!(contour.right_shoulder.width, 174.5);
        assert_eq!(
            contour.body,
            MacNotchRect {
                x: 8.0,
                y: 32.0,
                width: 544.0,
                height: 184.0,
            }
        );
        assert!(contour.left_shoulder.x + contour.left_shoulder.width < contour.right_shoulder.x);
    }

    #[test]
    fn medium_contour_rejects_a_gap_without_readable_shoulders() {
        assert!(medium_contour_geometry(MediumContourSpec {
            width: 210.0,
            height: 120.0,
            header: 32.0,
            gap_left: 8.0,
            gap_right: 202.0,
            outer_inset: 8.0,
            bottom_inset: 8.0,
            top_inset: 3.0,
            notch_clearance: 5.0,
        })
        .is_none());
    }

    #[test]
    fn fallback_geometry_never_fabricates_notch_dimensions() {
        let geometry = fallback_geometry("test", false, Some("unavailable"));
        assert_eq!(geometry.notch_width, 0.0);
        assert_eq!(geometry.notch_height, 0.0);
        assert_eq!(geometry.closed_width, FALLBACK_CLOSED_WIDTH);
        assert_eq!(geometry.closed_height, FALLBACK_CLOSED_HEIGHT);
        assert!(!geometry.has_hardware_notch);
    }

    #[test]
    fn compact_host_size_reserves_side_information_around_the_notch() {
        let (width, height) = compact_host_size(1512.0, 982.0, 32.0, 49.0, 185.0, true);
        assert_eq!(width, 417.0);
        assert_eq!(height, 32.0);
    }

    #[test]
    fn compact_native_side_spans_match_the_css_camera_clearance() {
        let (left, right) = compact_side_spans(417.0, 116.0, 301.0)
            .expect("standard hardware notch should leave two readable sides");
        assert_eq!(
            left,
            CompactSideSpan {
                x: 4.0,
                width: 104.0
            }
        );
        assert_eq!(
            right,
            CompactSideSpan {
                x: 309.0,
                width: 104.0,
            }
        );
    }

    #[test]
    fn compact_native_side_radius_tracks_short_safe_areas() {
        assert_eq!(compact_side_vertical_geometry(24.0), (18.0, 9.0));
        assert_eq!(compact_side_vertical_geometry(32.0), (26.0, 13.0));
        assert_eq!(compact_side_vertical_geometry(38.0), (32.0, 16.0));
    }

    #[test]
    fn compact_host_size_uses_fallback_without_hardware_notch() {
        let (width, height) = compact_host_size(1512.0, 982.0, 0.0, 49.0, 0.0, false);
        assert_eq!(width, FALLBACK_CLOSED_WIDTH);
        assert_eq!(height, 49.0);
    }

    #[test]
    fn compact_host_size_keeps_small_external_display_fallback_readable() {
        let (width, height) = compact_host_size(1920.0, 1080.0, 0.0, 24.0, 0.0, false);
        assert_eq!(width, FALLBACK_CLOSED_WIDTH);
        assert_eq!(height, FALLBACK_CLOSED_HEIGHT);
    }

    #[test]
    fn compact_host_size_keeps_fallback_inside_a_narrow_display() {
        let (width, height) = compact_host_size(180.0, 180.0, 0.0, 24.0, 0.0, false);
        assert_eq!(width, 180.0);
        assert_eq!(height, FALLBACK_CLOSED_HEIGHT);
    }

    #[test]
    fn compact_host_size_fits_an_extremely_narrow_virtual_display() {
        let (width, height) = compact_host_size(96.0, 96.0, 0.0, 24.0, 0.0, false);
        assert_eq!(width, 96.0);
        assert_eq!(height, 38.0);
    }

    #[test]
    fn compact_host_size_clamps_height_to_an_extremely_short_display() {
        let (width, height) = compact_host_size(320.0, 20.0, 32.0, 49.0, 185.0, true);
        assert_eq!(width, 320.0);
        assert_eq!(height, 20.0);
    }

    #[test]
    fn inferred_notch_bounds_use_global_auxiliary_rect_origins() {
        let screen = MacNotchRect {
            x: -1512.0,
            y: 0.0,
            width: 1512.0,
            height: 982.0,
        };
        let left = MacNotchRect {
            x: -1512.0,
            y: 950.0,
            width: 663.0,
            height: 32.0,
        };
        let right = MacNotchRect {
            x: -664.0,
            y: 950.0,
            width: 664.0,
            height: 32.0,
        };

        assert_eq!(
            inferred_notch_bounds(screen, left, right),
            Some((-849.0, -664.0))
        );
    }

    #[test]
    fn inferred_notch_bounds_reject_full_width_or_out_of_screen_gaps() {
        let screen = MacNotchRect {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 600.0,
        };
        assert_eq!(
            inferred_notch_bounds(screen, MacNotchRect::default(), MacNotchRect::default()),
            None
        );
        assert_eq!(
            inferred_notch_bounds(
                screen,
                MacNotchRect {
                    x: -150.0,
                    y: 0.0,
                    width: 50.0,
                    height: 32.0,
                },
                MacNotchRect {
                    x: 900.0,
                    y: 0.0,
                    width: 100.0,
                    height: 32.0,
                },
            ),
            None
        );
    }

    #[test]
    fn inferred_notch_bounds_reject_non_top_auxiliary_areas() {
        let screen = MacNotchRect {
            x: 0.0,
            y: 0.0,
            width: 1512.0,
            height: 982.0,
        };
        let left = MacNotchRect {
            x: 0.0,
            y: 900.0,
            width: 663.0,
            height: 32.0,
        };
        let right = MacNotchRect {
            x: 848.0,
            y: 950.0,
            width: 664.0,
            height: 32.0,
        };

        // A positive gap alone is not enough evidence of hardware. Both
        // auxiliary reservations must touch the same physical top edge.
        assert_eq!(inferred_notch_bounds(screen, left, right), None);
    }

    #[test]
    fn pointer_proximity_uses_appkit_logical_point_margin() {
        let rect = MacNotchRect {
            x: 547.0,
            y: 950.0,
            width: 417.0,
            height: 32.0,
        };

        assert!(point_is_near_rect(560.0, 960.0, rect, 0.0));
        assert!(point_is_near_rect(544.0, 950.0, rect, 5.0));
        assert!(point_is_near_rect(966.0, 987.0, rect, 6.0));
        assert!(!point_is_near_rect(540.0, 950.0, rect, 5.0));
        assert!(!point_is_near_rect(700.0, 989.0, rect, 6.0));
    }

    #[test]
    fn fallback_pointer_proximity_is_explicitly_unsupported() {
        let value = serde_json::to_value(fallback_pointer_proximity("test", Some("unavailable")))
            .expect("pointer sample should serialize");
        assert_eq!(value["supported"], false);
        assert_eq!(value["windowVisible"], false);
        assert_eq!(value["nearWindow"], false);
        assert!(value.get("window_visible").is_none());
    }
}
