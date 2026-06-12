using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using OpenStudio.App.Export;
using OpenStudio.Core;
using OpenStudio.Core.Models;
using OpenStudio.Core.Zoom;
using OpenStudio.Recorder;
using OpenStudio.Recorder.Audio;
using OpenStudio.Recorder.Capture;

namespace OpenStudio.App;

/// <summary>
/// The editor's host object: chrome.webview.hostObjects.bridge.* — everything the
/// browser sandbox can't do (§2). Methods take/return JSON strings; long-running work
/// reports back through PostWebMessageAsJson events.
/// </summary>
[ClassInterface(ClassInterfaceType.AutoDual)]
[ComVisible(true)]
public class Bridge
{
    private readonly MainWindow _window;
    private readonly CoreWebView2 _webview;
    private readonly CoreWebView2Environment _environment;
    private readonly RecordingController _recording;
    private Mp4Exporter? _exporter;

    private sealed class RecordingRequest : RecordingOptions
    {
        public int Countdown { get; set; } = 3;
    }

    public Bridge(MainWindow window, CoreWebView2 webview, CoreWebView2Environment environment, RecordingController recording)
    {
        _window = window;
        _webview = webview;
        _environment = environment;
        _recording = recording;
    }

    // ---- App / launcher ----

    public string GetAppInfo() => Json.Serialize(new
    {
        version = typeof(Bridge).Assembly.GetName().Version?.ToString() ?? "0.0",
        storageDir = _recording.StorageDir,
    });

    public string ListMonitors() => Json.Serialize(Monitors.All().Select(m => new
    {
        deviceName = m.DeviceName,
        x = m.X,
        y = m.Y,
        width = m.Width,
        height = m.Height,
        isPrimary = m.IsPrimary,
        scale = m.Scale,
        refreshRate = m.RefreshRate,
    }));

    public string ListMicDevices()
    {
        try
        {
            return Json.Serialize(AudioDevices.CaptureDevices());
        }
        catch
        {
            return "[]";
        }
    }

    public string ListCameraDevices() => Json.Serialize(WebcamRecorder.Devices());

    public string ListWindows() => Json.Serialize(WindowEnum.TopLevel().Select(w => new
    {
        hwnd = w.Hwnd,
        title = w.Title,
        processName = w.ProcessName,
        width = w.Width,
        height = w.Height,
    }));

    /// <summary>Shows the drag-select overlay (§3.1 region capture). Returns the region
    /// JSON in monitor-relative physical pixels, or "" if cancelled.</summary>
    public string PickRegion(string monitorDeviceName)
    {
        var monitor = Monitors.ByDeviceName(monitorDeviceName);
        if (monitor == null) return "";
        var selector = new RegionSelectorWindow(monitor);
        _window.Hide();
        try
        {
            selector.ShowDialog();
        }
        finally
        {
            _window.Show();
            _window.Activate();
        }
        return selector.Result == null ? "" : Json.Serialize(selector.Result);
    }

    public string ListRecentProjects()
    {
        var items = new List<object>();
        foreach (var path in RecentProjects.List())
        {
            if (!ProjectStore.IsProject(path)) continue;
            try
            {
                var meta = ProjectStore.LoadMeta(path);
                items.Add(new
                {
                    path,
                    name = Path.GetFileNameWithoutExtension(path),
                    durationSec = meta.DurationSec,
                    recordedAtUtc = meta.RecordedAtUtc,
                    width = meta.Width,
                    height = meta.Height,
                });
            }
            catch { }
        }
        return Json.Serialize(items);
    }

    public string BrowseForProject()
    {
        var dialog = new OpenFileDialog
        {
            Title = "Open OpenStudio project (select its meta.json)",
            Filter = "OpenStudio project|meta.json;project.json",
        };
        if (dialog.ShowDialog(_window) != true) return "";
        return Path.GetDirectoryName(dialog.FileName) ?? "";
    }

    // ---- Project ----

    public string OpenProject(string projectDir)
    {
        try
        {
            if (!ProjectStore.IsProject(projectDir))
                return Json.Serialize(new { error = "Not an OpenStudio project folder." });

            // Media is served at https://media.openstudio/* by MainWindow's
            // WebResourceRequested handler (Range + CORS headers, no canvas tainting).
            _window.CurrentProjectDir = projectDir;

            RecentProjects.Add(projectDir);
            return Json.Serialize(new
            {
                projectDir,
                mediaBase = "https://media.openstudio/",
                project = ProjectStore.LoadProject(projectDir),
                meta = ProjectStore.LoadMeta(projectDir),
            });
        }
        catch (Exception ex)
        {
            return Json.Serialize(new { error = ex.Message });
        }
    }

    public void SaveProject(string projectDir, string projectJson)
    {
        var project = Json.Deserialize<ProjectFile>(projectJson);
        if (project != null) ProjectStore.SaveProject(projectDir, project);
    }

    /// <summary>Re-runs auto-zoom generation with new tunables; manual/pinned segments
    /// (passed in keepJson) are preserved and carved around (§4.1).</summary>
    public string RegenerateZooms(string projectDir, string tunablesJson, string keepJson)
    {
        try
        {
            var meta = ProjectStore.LoadMeta(projectDir);
            var tunables = Json.Deserialize<AutoZoomTunables>(tunablesJson) ?? new AutoZoomTunables();
            var keep = Json.Deserialize<List<ZoomSegment>>(keepJson) ?? new List<ZoomSegment>();
            var events = ProjectStore.LoadEvents(projectDir);
            foreach (var ev in events) ev.T -= meta.VideoStartOffsetMs; // rebase to video clock
            events.RemoveAll(ev => ev.T < 0);

            var segments = AutoZoomGenerator.Generate(
                events, meta.Width, meta.Height, meta.DurationSec, tunables, keep);
            return Json.Serialize(segments);
        }
        catch (Exception ex)
        {
            return Json.Serialize(new { error = ex.Message });
        }
    }

    // ---- Recording ----

    public void StartRecording(string optionsJson)
    {
        var req = Json.Deserialize<RecordingRequest>(optionsJson) ?? new RecordingRequest();
        _ = _recording.StartAsync(req, req.Countdown);
    }

    public void StopRecording() => _ = _recording.StopAsync();

    public void CancelRecording() => _ = _recording.CancelAsync();

    public void TogglePauseRecording() => _recording.TogglePause();

    // ---- Export ----

    /// <summary>Shows the save dialog and starts the export. Returns the chosen path
    /// immediately ("" if cancelled); progress/done/error arrive as messages.</summary>
    public string BeginExport(string projectDir, string settingsJson, string suggestedName)
    {
        var settings = Json.Deserialize<ExportSettings>(settingsJson);
        if (settings == null) return "";

        var isGif = settings.Format == "gif";
        var dialog = new SaveFileDialog
        {
            Title = "Export video",
            FileName = suggestedName,
            Filter = isGif ? "GIF animation|*.gif" : "MP4 video|*.mp4",
            DefaultExt = isGif ? ".gif" : ".mp4",
            InitialDirectory = Path.GetDirectoryName(projectDir) ?? "",
        };
        if (dialog.ShowDialog(_window) != true) return "";
        var outputPath = dialog.FileName;

        _exporter?.Dispose();
        var exporter = new Mp4Exporter(_window.PostToEditor);
        _exporter = exporter;
        _ = Task.Run(async () =>
        {
            try
            {
                await exporter.RunAsync(_webview, _environment, _window.Dispatcher, projectDir, settings, outputPath);
                if (settings.Format == "mp4") Mp4Faststart.Apply(outputPath);
                Log.Info($"Export done → {outputPath}");
                _window.PostToEditor(Json.Serialize(new { type = "export:done", path = outputPath }));
            }
            catch (OperationCanceledException)
            {
                _window.PostToEditor(Json.Serialize(new { type = "export:cancelled" }));
            }
            catch (Exception ex)
            {
                Log.Error("Export failed", ex);
                _window.PostToEditor(Json.Serialize(new { type = "export:error", message = ex.Message }));
            }
        });
        return outputPath;
    }

    public void FrameReady() => _exporter?.NotifyFrameReady();

    public void CancelExport() => _exporter?.Cancel();

    // ---- Background music (§5.5) ----

    /// <summary>Picks an audio file and copies it into the project folder (portability).
    /// Returns the project-relative file name, or "".</summary>
    public string PickMusicFile(string projectDir)
    {
        var dialog = new OpenFileDialog
        {
            Title = "Choose background music",
            Filter = "Audio|*.mp3;*.wav;*.m4a;*.aac;*.flac;*.wma",
        };
        if (dialog.ShowDialog(_window) != true) return "";
        var name = "music" + Path.GetExtension(dialog.FileName).ToLowerInvariant();
        foreach (var old in Directory.GetFiles(projectDir, "music.*"))
        {
            try { File.Delete(old); } catch { }
        }
        File.Copy(dialog.FileName, Path.Combine(projectDir, name), overwrite: true);
        return name;
    }

    // ---- Style presets (§5.3) ----

    private static string PresetsDir
    {
        get
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OpenStudio", "presets");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    private static string PresetPath(string name)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        return Path.Combine(PresetsDir, name + ".json");
    }

    public string ListStylePresets() => Json.Serialize(
        Directory.GetFiles(PresetsDir, "*.json")
            .Select(Path.GetFileNameWithoutExtension)
            .OrderBy(n => n)
            .ToList());

    public void SaveStylePreset(string name, string json) => File.WriteAllText(PresetPath(name), json);

    public string LoadStylePreset(string name)
    {
        var path = PresetPath(name);
        return File.Exists(path) ? File.ReadAllText(path) : "";
    }

    public void DeleteStylePreset(string name)
    {
        try { File.Delete(PresetPath(name)); } catch { }
    }

    public string ImportStylePreset()
    {
        var dialog = new OpenFileDialog { Title = "Import style preset", Filter = "Preset|*.json" };
        if (dialog.ShowDialog(_window) != true) return "";
        var name = Path.GetFileNameWithoutExtension(dialog.FileName);
        File.Copy(dialog.FileName, PresetPath(name), overwrite: true);
        return name;
    }

    public string ExportStylePreset(string name)
    {
        var src = PresetPath(name);
        if (!File.Exists(src)) return "";
        var dialog = new SaveFileDialog { FileName = name + ".json", Filter = "Preset|*.json" };
        if (dialog.ShowDialog(_window) != true) return "";
        File.Copy(src, dialog.FileName, overwrite: true);
        return dialog.FileName;
    }

    // ---- Captions (§5.6) ----

    private CancellationTokenSource? _captionCts;

    public string GetCaptionStatus() => Json.Serialize(new
    {
        modelReady = Captions.Transcriber.ModelReady,
        modelPath = Captions.Transcriber.ModelPath,
    });

    /// <summary>Downloads the whisper model if needed, then transcribes mic.wav.
    /// Progress arrives as caption:* messages; the editor stores the words in project.json.</summary>
    public void GenerateCaptions(string projectDir)
    {
        _captionCts?.Cancel();
        var cts = new CancellationTokenSource();
        _captionCts = cts;
        _ = Task.Run(async () =>
        {
            try
            {
                if (!Captions.Transcriber.ModelReady)
                {
                    var dl = new Progress<double>(p => _window.PostToEditor(
                        Json.Serialize(new { type = "caption:progress", phase = "downloading", percent = p })));
                    await Captions.Transcriber.DownloadModelAsync(dl, cts.Token);
                }
                var tp = new Progress<double>(p => _window.PostToEditor(
                    Json.Serialize(new { type = "caption:progress", phase = "transcribing", percent = p })));
                var words = await Captions.Transcriber.TranscribeAsync(projectDir, tp, cts.Token);
                _window.PostToEditor(Json.Serialize(new { type = "caption:done", words }));
            }
            catch (OperationCanceledException)
            {
                _window.PostToEditor(Json.Serialize(new { type = "caption:cancelled" }));
            }
            catch (Exception ex)
            {
                _window.PostToEditor(Json.Serialize(new { type = "caption:error", message = ex.Message }));
            }
        });
    }

    public void CancelCaptions() => _captionCts?.Cancel();

    public string SaveText(string suggestedName, string filter, string content)
    {
        var dialog = new SaveFileDialog
        {
            FileName = suggestedName,
            Filter = filter,
        };
        if (dialog.ShowDialog(_window) != true) return "";
        File.WriteAllText(dialog.FileName, content);
        return dialog.FileName;
    }

    // ---- Files / misc ----

    public string SavePng(string suggestedName, string dataUrl)
    {
        var dialog = new SaveFileDialog
        {
            Title = "Save frame",
            FileName = suggestedName,
            Filter = "PNG image|*.png",
            DefaultExt = ".png",
        };
        if (dialog.ShowDialog(_window) != true) return "";
        var comma = dataUrl.IndexOf(',');
        if (comma < 0) return "";
        File.WriteAllBytes(dialog.FileName, Convert.FromBase64String(dataUrl[(comma + 1)..]));
        return dialog.FileName;
    }

    public void OpenContainingFolder(string path)
    {
        if (File.Exists(path))
            Process.Start("explorer.exe", $"/select,\"{path}\"");
        else if (Directory.Exists(path))
            Process.Start("explorer.exe", $"\"{path}\"");
    }
}
