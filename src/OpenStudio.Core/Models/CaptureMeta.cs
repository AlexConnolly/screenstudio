namespace OpenStudio.Core.Models;

/// <summary>meta.json — immutable capture metadata written by the recorder (§7.1).</summary>
public sealed class CaptureMeta
{
    public int Version { get; set; } = 1;
    public string AppVersion { get; set; } = "";
    public string RecordedAtUtc { get; set; } = "";
    public double DurationSec { get; set; }
    /// <summary>True pixel dimensions of the capture (§3.3 HiDPI aware).</summary>
    public int Width { get; set; }
    public int Height { get; set; }
    public double Scale { get; set; } = 1.0;
    public int Fps { get; set; } = 60;
    public MonitorMeta Monitor { get; set; } = new();
    /// <summary>Track start offsets in ms relative to the session clock (events t=0),
    /// so the editor can align all tracks on one master clock (§3.3).</summary>
    public double VideoStartOffsetMs { get; set; }
    public double MicStartOffsetMs { get; set; }
    public double SysStartOffsetMs { get; set; }
    public double CamStartOffsetMs { get; set; }
    public bool HasMic { get; set; }
    public bool HasSystemAudio { get; set; }
    public bool HasWebcam { get; set; }
    /// <summary>"full" | "modifiers" | "ticks" (§3.4 privacy).</summary>
    public string KeyPrivacyMode { get; set; } = "modifiers";
}

public sealed class MonitorMeta
{
    public string DeviceName { get; set; } = "";
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public double RefreshRate { get; set; }
    public bool IsPrimary { get; set; }
}

public static class ProjectPaths
{
    public const string ProjectJson = "project.json";
    public const string MetaJson = "meta.json";
    public const string EventsJsonl = "events.jsonl";
    public const string ScreenMp4 = "screen.mp4";
    public const string CameraMp4 = "camera.mp4";
    public const string MicWav = "mic.wav";
    public const string SysWav = "sys.wav";
}
