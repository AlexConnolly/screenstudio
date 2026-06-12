namespace OpenStudio.Core.Models;

/// <summary>project.json — all edit state, non-destructive (§7.1). Versioned schema.</summary>
public sealed class ProjectFile
{
    public int Version { get; set; } = 1;
    public string Name { get; set; } = "";
    public ZoomConfig Zoom { get; set; } = new();
    /// <summary>Removed source-time ranges (ripple-deleted in the editor).</summary>
    public List<TimeRange> Cuts { get; set; } = new();
    /// <summary>Split points (source time, seconds) the user has placed on the timeline.</summary>
    public List<double> Splits { get; set; } = new();
    public List<SpeedRange> Speed { get; set; } = new();
    public TrimRange Trim { get; set; } = new();
    public StyleConfig Style { get; set; } = new();
    public CursorConfig Cursor { get; set; } = new();
    public KeystrokeConfig Keystrokes { get; set; } = new();
    public AudioConfig Audio { get; set; } = new();
    public WebcamConfig Webcam { get; set; } = new();
    public CaptionConfig Captions { get; set; } = new();
}

/// <summary>TikTok-style voice captions (§5.6): short word-timed chunks burned in by the
/// render core. Words are transcribed on-device and stored in video-clock seconds.</summary>
public sealed class CaptionConfig
{
    public bool Enabled { get; set; } = true;
    /// <summary>Maximum words shown at once (1–5; TikTok pacing ≈ 3).</summary>
    public int MaxWords { get; set; } = 3;
    /// <summary>"center" | "bottom" | "top"</summary>
    public string Position { get; set; } = "center";
    public bool Uppercase { get; set; } = true;
    public double FontScale { get; set; } = 1.0;
    public string Color { get; set; } = "#ffffff";
    /// <summary>The currently spoken word is tinted with this.</summary>
    public string HighlightColor { get; set; } = "#fde047";
    public bool Outline { get; set; } = true;
    /// <summary>Scale "pop" when a new chunk appears.</summary>
    public bool Pop { get; set; } = true;
    public List<CaptionWord> Words { get; set; } = new();
}

public sealed class CaptionWord
{
    /// <summary>Start/end in video-clock seconds.</summary>
    public double T0 { get; set; }
    public double T1 { get; set; }
    public string Text { get; set; } = "";
}

public sealed class WebcamConfig
{
    public bool Enabled { get; set; }
    /// <summary>"circle" | "rounded"</summary>
    public string Shape { get; set; } = "circle";
    public bool Mirror { get; set; }
    /// <summary>Bubble height as a fraction of output height.</summary>
    public double Size { get; set; } = 0.24;
    /// <summary>Normalized position of the bubble (0,0 = top-left, 1,1 = bottom-right).</summary>
    public double Nx { get; set; } = 0.97;
    public double Ny { get; set; } = 0.96;
    public double BorderWidth { get; set; }
    public bool Shadow { get; set; } = true;
    /// <summary>Bubble slides away when the cursor approaches (§5.4 dodge).</summary>
    public bool AutoDodge { get; set; } = true;
    /// <summary>Blur the screen content behind the bubble (§5.4).</summary>
    public bool BackdropBlur { get; set; }
    /// <summary>Layout keyframes on the timeline (§5.4): each takes effect at its source
    /// time with an animated transition — including full-screen talking-head segments.</summary>
    public List<WebcamKeyframe> Keyframes { get; set; } = new();
}

public sealed class WebcamKeyframe
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..8];
    /// <summary>Source time, seconds.</summary>
    public double T { get; set; }
    public double Size { get; set; } = 0.24;
    public double Nx { get; set; } = 0.97;
    public double Ny { get; set; } = 0.96;
    public bool Fullscreen { get; set; }
    public bool Hidden { get; set; }
}

public sealed class TimeRange
{
    public double Start { get; set; }
    public double End { get; set; }
}

public sealed class SpeedRange
{
    public double Start { get; set; }
    public double End { get; set; }
    public double Factor { get; set; } = 1.0;
}

public sealed class TrimRange
{
    public double Start { get; set; }
    public double? End { get; set; }
}

public sealed class ZoomConfig
{
    public bool AutoEnabled { get; set; } = true;
    public AutoZoomTunables Tunables { get; set; } = new();
    public List<ZoomSegment> Segments { get; set; } = new();
}

public sealed class ZoomSegment
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..8];
    /// <summary>"auto" or "manual". Pinned autos survive regeneration like manuals.</summary>
    public string Kind { get; set; } = "auto";
    public bool Pinned { get; set; }
    /// <summary>Source time, seconds.</summary>
    public double Start { get; set; }
    public double End { get; set; }
    public double Zoom { get; set; } = 1.75;
    /// <summary>Target center, normalized 0..1 in (cropped) capture space.</summary>
    public double Cx { get; set; } = 0.5;
    public double Cy { get; set; } = 0.5;
    public bool Follow { get; set; } = true;
    public double EaseIn { get; set; } = 1.0;
    public double EaseOut { get; set; } = 1.2;
}

public sealed class AutoZoomTunables
{
    /// <summary>Clicks within this many seconds of cluster's last activity may merge (§4.1).</summary>
    public double ClusterWindow { get; set; } = 3.0;
    /// <summary>Spatial merge radius as a fraction of the larger frame dimension.</summary>
    public double ClusterRadiusFrac { get; set; } = 0.25;
    /// <summary>Seconds without clicks/typing before zooming back out.</summary>
    public double Dwell { get; set; } = 2.5;
    public double DefaultZoom { get; set; } = 1.75;
    /// <summary>Scales (zoom - 1): subtle ≈ 0.7, medium = 1.0, strong ≈ 1.4.</summary>
    public double Intensity { get; set; } = 1.0;
    public int TypingMinKeys { get; set; } = 3;
    public double TypingWindow { get; set; } = 1.0;
    public double EaseIn { get; set; } = 1.0;
    public double EaseOut { get; set; } = 1.2;
    /// <summary>Zoom begins slightly before the first click so it lands on the action.</summary>
    public double LeadIn { get; set; } = 0.15;
    /// <summary>Segments closer than this are made contiguous so the camera blends
    /// target→target without returning to full frame (§4.1 easing).</summary>
    public double MergeGap { get; set; } = 1.0;
}

public sealed class StyleConfig
{
    /// <summary>Inset padding as a fraction of the smaller output dimension.</summary>
    public double Padding { get; set; } = 0.07;
    public BackgroundConfig Background { get; set; } = new();
    public double CornerRadius { get; set; } = 12;
    public ShadowConfig Shadow { get; set; } = new();
    public BorderConfig Border { get; set; } = new();
    /// <summary>"16:9" | "9:16" | "1:1" | "original"</summary>
    public string Aspect { get; set; } = "16:9";
    /// <summary>Optional normalized crop of the screen recording.</summary>
    public CropRect? Crop { get; set; }
}

public sealed class BackgroundConfig
{
    /// <summary>"solid" | "gradient" | "image"</summary>
    public string Type { get; set; } = "gradient";
    public string Color { get; set; } = "#0f1117";
    public string From { get; set; } = "#4f46e5";
    public string To { get; set; } = "#0ea5e9";
    public double Angle { get; set; } = 135;
    public string? ImagePath { get; set; }
    public double Blur { get; set; }
}

public sealed class ShadowConfig
{
    public double Size { get; set; } = 40;
    public double Opacity { get; set; } = 0.5;
    public double OffsetX { get; set; }
    public double OffsetY { get; set; } = 12;
}

public sealed class BorderConfig
{
    public double Width { get; set; }
    public string Color { get; set; } = "#ffffff";
    public double Opacity { get; set; } = 0.15;
}

public sealed class CropRect
{
    public double X { get; set; }
    public double Y { get; set; }
    public double W { get; set; } = 1;
    public double H { get; set; } = 1;
}

public sealed class CursorConfig
{
    /// <summary>"off" | "subtle" | "medium" | "strong"</summary>
    public string Smoothing { get; set; } = "medium";
    public double Size { get; set; } = 1.0;
    public bool AutoHide { get; set; } = true;
    public double AutoHideDelay { get; set; } = 2.0;
    public bool Hidden { get; set; }
    public bool ClickEffects { get; set; } = true;
    public string ClickColor { get; set; } = "#60a5fa";
    public bool ScaleOnClick { get; set; } = true;
    /// <summary>Ghosting on fast cursor moves + camera pans (§4.3 "natural movement").</summary>
    public bool MotionBlur { get; set; } = true;
    /// <summary>Subtle synthesized click tick mixed at export (§4.3).</summary>
    public bool ClickSound { get; set; }
    public double ClickSoundVolume { get; set; } = 0.6;
}

public sealed class KeystrokeConfig
{
    public bool Enabled { get; set; } = true;
    /// <summary>"modifiers" (default, privacy-safe) | "all"</summary>
    public string Mode { get; set; } = "modifiers";
    /// <summary>"bottom" | "top"</summary>
    public string Position { get; set; } = "bottom";
    /// <summary>"dark" | "light"</summary>
    public string Theme { get; set; } = "dark";
}

public sealed class AudioConfig
{
    public double MicVolume { get; set; } = 1.0;
    public bool MicMuted { get; set; }
    public double SysVolume { get; set; } = 1.0;
    public bool SysMuted { get; set; }
    public bool Normalize { get; set; } = true;
    /// <summary>On-device spectral noise removal on the mic track at export (§5.5).</summary>
    public bool Denoise { get; set; }
    /// <summary>Background music file inside the project folder (§5.5), e.g. "music.mp3".</summary>
    public string? MusicFile { get; set; }
    public double MusicVolume { get; set; } = 0.5;
    /// <summary>Auto-duck music under voice.</summary>
    public bool Duck { get; set; } = true;
    /// <summary>Music gain while voice is present (0–1).</summary>
    public double DuckAmount { get; set; } = 0.25;
}
